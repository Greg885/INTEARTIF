(() => {
  const $ = id => document.getElementById(id);
  const colors = ['red', 'blue', 'green', 'yellow', 'white', 'orange'];
  const dirs = {
    N: { axis: 'NS', x: 465, y: -75, dx: 0, dy: 1, stop: 254, rotation: 180 },
    S: { axis: 'NS', x: 535, y: 1075, dx: 0, dy: -1, stop: 746, rotation: 0 },
    W: { axis: 'EW', x: -75, y: 535, dx: 1, dy: 0, stop: 254, rotation: 90 },
    E: { axis: 'EW', x: 1075, y: 465, dx: -1, dy: 0, stop: 746, rotation: 270 }
  };
  const laneIds = Object.keys(dirs);
  const arrivalRates = { low: 0.4, normal: 0.8, rush: 1.5 };
  const lightPositions = [
    { x: 343, y: 287, axis: 'NS' }, { x: 657, y: 713, axis: 'NS' },
    { x: 287, y: 657, axis: 'EW' }, { x: 713, y: 343, axis: 'EW' }
  ];
  const place = (el, x, y) => { el.style.left = `${x / 10}%`; el.style.top = `${y / 10}%`; };
  const fmtQ = n => n == null ? '—' : Number(n).toFixed(2);

  const rand = (() => {
    let state = 1;
    return {
      reset() { state = crypto.getRandomValues(new Uint32Array(1))[0]; },
      next() { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; }
    };
  })();

  let env = { max_queue: 10, arrival_rate: 0.8, service_capacity: 2, switch_lost_steps: 1, switch_penalty: 0, max_arrivals: 3 };
  let modelsMap = new Map();

  class AIVsAIIntersection {
    constructor(prefix) {
      this.prefix = prefix;
      this.carsLayer = $(`${prefix}-cars`);
      this.lightsLayer = $(`${prefix}-lights`);
      this.signals = [];
      this.modelId = 'baseline';
      this.modelCfg = null;
      this.decisionBusy = false;
      this.reset();
      for (const p of lightPositions) {
        const el = document.createElement('img');
        el.className = 'light';
        el.alt = '';
        place(el, p.x, p.y);
        this.lightsLayer.appendChild(el);
        this.signals.push({ ...p, el });
      }
      this.updateSignals();
    }

    reset() {
      if (this.carsLayer) this.carsLayer.replaceChildren();
      this.cars = [];
      this.pending = { N: [], S: [], E: [], W: [] };
      this.green = 'NS';
      this.phase = 'green';
      this.phaseTime = 0;
      this.greenTime = 0;
      this.served = 0;
      this.arrived = 0;
      this.totalWait = 0;
      this.nextId = 0;
      this.switches = 0;
      this.lostSteps = 0;
      this.serviceTokens = env.service_capacity;
      this.reward = 0;
      this.decisionBusy = false;
      if (this.signals?.length) this.updateSignals();
      this.updateStats();
    }

    signalColor(axis) {
      return this.phase === 'green'
        ? (axis === this.green ? 'green' : 'red')
        : (this.phase === 'yellow' && axis === this.green ? 'yellow' : 'red');
    }

    updateSignals() {
      for (const light of this.signals) {
        light.el.src = `/static/assets/traffic_light_${this.signalColor(light.axis)}.svg`;
      }
      for (const [axis, id] of [['NS', 'ns'], ['EW', 'ew']]) {
        const el = $(`${this.prefix}-${id}-state`);
        const color = this.signalColor(axis);
        el.textContent = color.toUpperCase();
        el.className = color;
      }
      const phase = $(`${this.prefix}-phase`);
      phase.textContent = this.phase === 'green'
        ? `${this.green === 'NS' ? 'NORTH–SOUTH' : 'EAST–WEST'} GREEN`
        : (this.phase === 'yellow' ? 'YELLOW · CLEARING' : 'ALL RED · SAFETY');
      phase.style.color = this.phase === 'green' ? '#65e6ad' : '#ffd36d';
    }

    switchLights() {
      if (this.phase !== 'green' || this.lostSteps > 0) return;
      this.switches++;
      this.reward -= env.switch_penalty;
      this.lostSteps = env.switch_lost_steps;
      this.serviceTokens = 0;
      this.phase = 'yellow';
      this.phaseTime = 0.9;
      this.updateSignals();
    }

    axisQueue(axis) {
      return this.cars.filter(c => dirs[c.dir].axis === axis && !c.committed).length +
        Object.entries(this.pending).filter(([dir]) => dirs[dir].axis === axis).reduce((n, [, q]) => n + q.length, 0);
    }

    receive(event) {
      if (this.axisQueue(dirs[event.dir].axis) >= env.max_queue) return;
      this.pending[event.dir].push(event.color);
      this.arrived++;
    }

    mdpTick() {
      if (this.lostSteps > 0) {
        this.lostSteps--;
        this.serviceTokens = 0;
      } else {
        this.serviceTokens = env.service_capacity;
      }
      this.reward -= this.axisQueue('NS') + this.axisQueue('EW');
    }

    observedState() {
      const counts = { NS: 0, EW: 0 };
      for (const car of this.cars) {
        const d = dirs[car.dir];
        const distance = Math.abs(d.stop - (d.dx ? d.x : d.y));
        if (!car.committed && car.progress <= distance + 0.01) counts[d.axis]++;
      }
      for (const [dir, queue] of Object.entries(this.pending)) counts[dirs[dir].axis] += queue.length;
      const cap = this.modelCfg?.max_queue ?? env.max_queue;
      return [
        Math.min(cap, counts.NS),
        Math.min(cap, counts.EW),
        this.green === 'NS' ? 0 : 1,
        Math.min((this.modelCfg?.switch_lost_steps ?? 1) - 1, Math.max(0, this.lostSteps - 1))
      ];
    }

    async decide(paused, matchActive, genId, currentGenFn) {
      if (this.modelId === 'baseline') {
        $(`${this.prefix}-q-info`).textContent = `Fixed-time rule · ${Math.max(0, 15 - this.greenTime).toFixed(1)}s before switch`;
        return;
      }
      if (this.decisionBusy || paused || !matchActive || this.phase !== 'green' || this.lostSteps > 0) return;
      this.decisionBusy = true;
      const state = this.observedState();
      try {
        const res = await fetch(`/api/training/models/${encodeURIComponent(this.modelId)}/decision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state })
        });
        const data = await res.json();
        if (!res.ok || genId !== currentGenFn() || this.phase !== 'green') return;
        const keep = data.actions.KEEP?.q ?? null;
        const sw = data.actions.SWITCH?.q ?? null;
        $(`${this.prefix}-q-info`).innerHTML =
          `State <b>(${state.join(',')})</b> · KEEP: <b>${fmtQ(keep)}</b> | SWITCH: <b>${fmtQ(sw)}</b> → <span style="color:#65e6ad;font-weight:700">${data.action}</span>`;
        if (data.action === 'SWITCH') this.switchLights();
      } catch (e) {
        $(`${this.prefix}-q-info`).textContent = `Error: ${e.message}`;
      } finally {
        this.decisionBusy = false;
      }
    }

    renderCar(c) {
      const d = dirs[c.dir];
      place(c.el, d.x + d.dx * c.progress, d.y + d.dy * c.progress);
    }

    spawnPending() {
      for (const key of laneIds) {
        if (!this.pending[key].length || this.cars.some(c => c.dir === key && c.progress < 95)) continue;
        const d = dirs[key], color = this.pending[key].shift();
        const el = document.createElement('img');
        el.className = 'car';
        el.alt = '';
        el.src = `/static/assets/car_${color}.svg`;
        el.style.transform = `translate(-50%,-50%) rotate(${d.rotation}deg)`;
        this.carsLayer.appendChild(el);
        const c = { id: this.nextId++, dir: key, progress: 0, waiting: 0, committed: false, el };
        this.cars.push(c);
        this.renderCar(c);
      }
    }

    updateStats() {
      $(`${this.prefix}-served`).textContent = this.served;
      $(`${this.prefix}-waiting`).textContent = this.cars.filter(c => c.waiting > 0).length + Object.values(this.pending).reduce((n, q) => n + q.length, 0);
      $(`${this.prefix}-switches`).textContent = this.switches;
      $(`${this.prefix}-waittime`).textContent = `${Math.floor(this.totalWait)}s`;
    }

    step(dt) {
      if (this.phase === 'green') {
        this.greenTime += dt;
        if (this.modelId === 'baseline' && this.greenTime >= 15) this.switchLights();
      } else {
        this.phaseTime -= dt;
        if (this.phaseTime <= 0) {
          if (this.phase === 'yellow') {
            this.phase = 'allred';
            this.phaseTime = 0.65;
          } else if (this.lostSteps > 0 || this.cars.some(c => c.committed && c.progress < 760)) {
            this.phaseTime = 0.1;
          } else {
            this.green = this.green === 'NS' ? 'EW' : 'NS';
            this.phase = 'green';
            this.greenTime = 0;
            this.serviceTokens = env.service_capacity;
          }
          this.updateSignals();
        }
      }
      this.spawnPending();
      for (const key of laneIds) {
        const d = dirs[key];
        let prev = Infinity;
        const lane = this.cars.filter(c => c.dir === key).sort((a, b) => b.progress - a.progress);
        for (const c of lane) {
          const distanceToStop = Math.abs(d.stop - (d.dx ? d.x : d.y));
          const allowed = this.phase === 'green' && this.green === d.axis && (c.committed || this.serviceTokens > 0);
          const limit = (allowed || c.committed) ? Infinity : distanceToStop;
          const target = Math.min(c.progress + 155 * dt, limit, prev - 76);
          const next = Math.max(c.progress, target);
          if (next - c.progress < 1e-5) c.waiting += dt;
          c.progress = next;
          if (!c.committed && allowed && c.progress >= distanceToStop - 0.01) {
            c.committed = true;
            this.serviceTokens = Math.max(0, this.serviceTokens - 1);
          }
          prev = c.progress;
          this.renderCar(c);
        }
      }
      this.cars = this.cars.filter(c => {
        if (c.progress > 1110) { c.el.remove(); this.served++; return false; }
        return true;
      });
      const waitingOnRoad = this.cars.filter(c => c.waiting > 0).length;
      const pendingCount = Object.values(this.pending).reduce((n, q) => n + q.length, 0);
      this.totalWait += (waitingOnRoad + pendingCount) * dt;
      this.updateStats();
    }
  }

  function createArenaHTML(prefix, defaultTitle) {
    return `
      <section class="arena" id="${prefix}-arena">
        <div class="section-title">
          <div>
            <p class="eyebrow">${prefix === 'ai1' ? 'CONTENDER 1 · LEFT' : 'CONTENDER 2 · RIGHT'}</p>
            <h1 id="${prefix}-title">${defaultTitle}</h1>
          </div>
          <span class="badge" id="${prefix}-phase">NORTH–SOUTH GREEN</span>
        </div>
        <div class="map-wrap">
          <div class="map">
            <img class="base" src="/static/assets/intersection.svg" alt="Intersection" />
            <div id="${prefix}-lights"></div>
            <div id="${prefix}-cars"></div>
            <span class="map-label nw">NORTH</span>
            <span class="map-label se">SOUTH</span>
            <span class="map-label sw">WEST</span>
            <span class="map-label ne">EAST</span>
          </div>
        </div>
        <div class="direction-row">
          <span>NORTH–SOUTH <b id="${prefix}-ns-state" class="green">GREEN</b></span>
          <span>EAST–WEST <b id="${prefix}-ew-state" class="red">RED</b></span>
        </div>
        <div class="stats duel-stats">
          <div><span>Served</span><strong id="${prefix}-served">0</strong></div>
          <div><span>Waiting</span><strong id="${prefix}-waiting">0</strong></div>
          <div><span>Switches</span><strong id="${prefix}-switches">0</strong></div>
          <div><span>Wait time</span><strong id="${prefix}-waittime">0s</strong></div>
        </div>
        <div class="baseline-note" id="${prefix}-q-info" style="margin-top:8px;font-size:11px;">Waiting for match start…</div>
      </section>
    `;
  }

  function mountAIVsAI() {
    const tabsBar = document.querySelector('.tabs');
    if (!tabsBar) return;

    const aiTabBtn = document.createElement('button');
    aiTabBtn.className = 'tab';
    aiTabBtn.type = 'button';
    aiTabBtn.dataset.tab = 'aivsai';
    aiTabBtn.setAttribute('role', 'tab');
    aiTabBtn.setAttribute('aria-selected', 'false');
    aiTabBtn.textContent = 'AI vs AI';
    tabsBar.appendChild(aiTabBtn);

    const screen = document.createElement('section');
    screen.id = 'aivsai-screen';
    screen.className = 'tab-screen setup-active';
    screen.hidden = true;
    screen.innerHTML = `
      <div id="aivsai-setup" class="match-setup" style="width:min(100%,650px);margin:16px auto;">
        <div>
          <p class="eyebrow">AI VS AI · BENCHMARK ARENA</p>
          <h1>Configure AI vs AI Duel</h1>
          <p>Pit two trained controllers (or a fixed-time baseline) against each other under identical traffic arrivals.</p>
        </div>
        <div class="environment-fields">
          <label>AI 1 (Left Intersection)
            <select id="aivsai-model-1"></select>
          </label>
          <label>AI 2 (Right Intersection)
            <select id="aivsai-model-2"></select>
          </label>
          <label>Traffic intensity
            <select id="aivsai-traffic">
              <option value="low">Low (λ = 0.4)</option>
              <option value="normal" selected>Normal (λ = 0.8)</option>
              <option value="rush">Rush Hour (λ = 1.5)</option>
            </select>
          </label>
          <label>Match duration
            <select id="aivsai-duration">
              <option value="60">1 minute</option>
              <option value="120" selected>2 minutes</option>
              <option value="180">3 minutes</option>
            </select>
          </label>
          <label>Maximum queue / axis
            <input id="aivsai-queues" type="number" min="1" max="30" value="10" />
          </label>
          <label>Service capacity / step
            <input id="aivsai-service" type="number" min="1" max="10" value="2" />
          </label>
          <label>Switch cooldown / steps
            <input id="aivsai-cooldown" type="number" min="1" max="5" value="1" />
          </label>
          <label>Switching penalty β
            <input id="aivsai-penalty" type="number" min="0" max="100" step="0.5" value="0" />
          </label>
        </div>
        <button id="aivsai-start" class="primary" type="button">▶ Start AI vs AI Match</button>
      </div>

      <div id="aivsai-hud" class="match-timer-hud" hidden style="display:flex;align-items:center;justify-content:center;gap:18px;padding:8px 16px;margin:6px auto 8px;width:max-content;border:1px solid #365566;border-radius:12px;background:#142634;">
        <span class="timer-label" style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:#9bb6c5;">AI DUEL CLOCK</span>
        <strong id="aivsai-clock" style="font-size:clamp(24px,2.8vw,36px);font-variant-numeric:tabular-nums;">02:00 remaining</strong>
        <button id="aivsai-pause" class="secondary" style="width:auto;margin:0;padding:8px 14px;">Ⅱ Pause</button>
        <button id="aivsai-reset" class="secondary" style="width:auto;margin:0;padding:8px 14px;">↺ New Setup</button>
      </div>

      <main id="aivsai-main" class="duel" hidden style="margin-top:8px;">
        ${createArenaHTML('ai1', '🤖 AI 1')}
        ${createArenaHTML('ai2', '🤖 AI 2')}
      </main>

      <div id="aivsai-result" class="result-overlay" hidden>
        <div class="result-card">
          <div class="result-icon" id="aivsai-res-icon">🏆</div>
          <h2 id="aivsai-res-title">Match Complete</h2>
          <p class="result-message" id="aivsai-res-msg"></p>
          <div class="result-table">
            <div class="result-table-head">
              <span>Metric</span><span id="aivsai-res-name1">AI 1</span><span id="aivsai-res-name2">AI 2</span>
            </div>
            <div><span>Total Wait Time</span><strong id="aivsai-res-wait1"></strong><strong id="aivsai-res-wait2"></strong></div>
            <div><span>Cars Served</span><strong id="aivsai-res-srv1"></strong><strong id="aivsai-res-srv2"></strong></div>
            <div><span>Light Switches</span><strong id="aivsai-res-sw1"></strong><strong id="aivsai-res-sw2"></strong></div>
            <div><span>Cumulative Reward</span><strong id="aivsai-res-rew1"></strong><strong id="aivsai-res-rew2"></strong></div>
          </div>
          <button id="aivsai-again" class="primary" type="button">Play Again</button>
        </div>
      </div>
    `;

    const playScreen = $('play-screen');
    playScreen.parentNode.insertBefore(screen, playScreen.nextSibling);

    const ai1 = new AIVsAIIntersection('ai1');
    const ai2 = new AIVsAIIntersection('ai2');

    let active = false, paused = true, elapsed = 0, duration = 120, spawnClock = 0, decisionClock = 0, gen = 0, last = performance.now();

    async function populateModels() {
      try {
        const res = await fetch('/api/training/models');
        const { models = [] } = await res.json();
        modelsMap.clear();
        const s1 = $('aivsai-model-1'), s2 = $('aivsai-model-2');
        const cur1 = s1.value, cur2 = s2.value;
        s1.replaceChildren(new Option('Fixed-time baseline · 15 s', 'baseline'));
        s2.replaceChildren(new Option('Fixed-time baseline · 15 s', 'baseline'));
        for (const m of models) {
          modelsMap.set(m.model_id, m);
          const algo = m.settings.algorithm === 'value_iteration' ? 'VI' : 'PI';
          const lbl = `${algo} · γ=${m.settings.gamma} · λ=${m.settings.mdp.arrival_rate} · β=${m.settings.mdp.switch_penalty} (${m.model_id.slice(0, 6)})`;
          s1.add(new Option(lbl, m.model_id));
          s2.add(new Option(lbl, m.model_id));
        }
        if ([...s1.options].some(o => o.value === cur1)) s1.value = cur1;
        else if (models.length >= 1) s1.selectedIndex = 1;
        if ([...s2.options].some(o => o.value === cur2)) s2.value = cur2;
        else if (models.length >= 2) s2.selectedIndex = 2;
      } catch (err) {
        console.error('Failed to load models for AI vs AI:', err);
      }
    }

    function showAIVsAISetup() {
      active = false; paused = true; gen++;
      $('aivsai-setup').hidden = false;
      $('aivsai-hud').hidden = true;
      $('aivsai-main').hidden = true;
      $('aivsai-result').hidden = true;
      populateModels();
    }

    document.querySelectorAll('[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        const isAIVsAI = tab.dataset.tab === 'aivsai';
        document.querySelectorAll('[data-tab]').forEach(b => {
          const sel = b === tab;
          b.classList.toggle('selected', sel);
          b.setAttribute('aria-selected', String(sel));
        });
        screen.hidden = !isAIVsAI;
        if (isAIVsAI) {
          $('train-screen').hidden = true;
          $('play-screen').hidden = true;
          showAIVsAISetup();
        }
      });
    });

    $('aivsai-start').addEventListener('click', () => {
      env = {
        arrival_rate: arrivalRates[$('aivsai-traffic').value],
        max_queue: Number($('aivsai-queues').value),
        service_capacity: Number($('aivsai-service').value),
        switch_lost_steps: Number($('aivsai-cooldown').value),
        switch_penalty: Number($('aivsai-penalty').value),
        max_arrivals: 3
      };
      duration = Number($('aivsai-duration').value);
      ai1.modelId = $('aivsai-model-1').value;
      ai2.modelId = $('aivsai-model-2').value;
      ai1.modelCfg = modelsMap.get(ai1.modelId)?.settings?.mdp ?? null;
      ai2.modelCfg = modelsMap.get(ai2.modelId)?.settings?.mdp ?? null;

      $('ai1-title').textContent = `🤖 ${$('aivsai-model-1').selectedOptions[0].textContent}`;
      $('ai2-title').textContent = `🤖 ${$('aivsai-model-2').selectedOptions[0].textContent}`;

      ai1.reset(); ai2.reset(); rand.reset();
      elapsed = 0; spawnClock = 0; decisionClock = 0; gen++;
      $('aivsai-setup').hidden = true;
      $('aivsai-hud').hidden = false;
      $('aivsai-main').hidden = false;
      $('aivsai-result').hidden = true;
      $('aivsai-pause').textContent = 'Ⅱ Pause';
      active = true; paused = false;
    });

    $('aivsai-pause').addEventListener('click', () => {
      paused = !paused;
      $('aivsai-pause').textContent = paused ? '▶ Resume' : 'Ⅱ Pause';
    });

    $('aivsai-reset').addEventListener('click', showAIVsAISetup);
    $('aivsai-again').addEventListener('click', showAIVsAISetup);

    function finishDuel() {
      active = false; paused = true;
      const diff = ai1.totalWait - ai2.totalWait;
      const tie = Math.abs(diff) < 0.1;
      const ai1Wins = diff < 0;
      $('aivsai-res-icon').textContent = tie ? '🤝' : '🏆';
      $('aivsai-res-title').textContent = tie ? 'It’s a Tie!' : (ai1Wins ? 'AI 1 Wins!' : 'AI 2 Wins!');
      $('aivsai-res-msg').textContent = tie
        ? 'Both controllers achieved virtually identical waiting times.'
        : `${ai1Wins ? 'AI 1 (Left)' : 'AI 2 (Right)'} minimized total waiting time by ${Math.abs(diff).toFixed(1)} seconds.`;
      $('aivsai-res-name1').textContent = 'AI 1';
      $('aivsai-res-name2').textContent = 'AI 2';
      $('aivsai-res-wait1').textContent = `${ai1.totalWait.toFixed(1)} s`;
      $('aivsai-res-wait2').textContent = `${ai2.totalWait.toFixed(1)} s`;
      $('aivsai-res-srv1').textContent = ai1.served;
      $('aivsai-res-srv2').textContent = ai2.served;
      $('aivsai-res-sw1').textContent = ai1.switches;
      $('aivsai-res-sw2').textContent = ai2.switches;
      $('aivsai-res-rew1').textContent = ai1.reward.toFixed(0);
      $('aivsai-res-rew2').textContent = ai2.reward.toFixed(0);
      $('aivsai-result').hidden = false;
    }

    function loop(now) {
      const dt = Math.min((now - last) / 1000, 0.06);
      last = now;
      if (active && !paused && !screen.hidden) {
        const stepDt = Math.min(dt, duration - elapsed);
        elapsed += stepDt;
        spawnClock += stepDt;
        decisionClock += stepDt;

        while (spawnClock >= 3) {
          spawnClock -= 3;
          for (const axis of ['NS', 'EW']) {
            let arrivals = 0, prod = 1, thresh = Math.exp(-env.arrival_rate);
            do { prod *= rand.next(); if (prod > thresh) arrivals++; } while (prod > thresh && arrivals < env.max_arrivals);
            for (let k = 0; k < arrivals; k++) {
              const lanes = axis === 'NS' ? ['N', 'S'] : ['E', 'W'];
              const event = { dir: lanes[Math.floor(rand.next() * 2)], color: colors[Math.floor(rand.next() * colors.length)] };
              ai1.receive(event);
              ai2.receive(event);
            }
          }
          ai1.mdpTick();
          ai2.mdpTick();
        }

        ai1.step(stepDt);
        ai2.step(stepDt);

        if (decisionClock >= 3) {
          decisionClock = 0;
          ai1.decide(paused, active, gen, () => gen);
          ai2.decide(paused, active, gen, () => gen);
        }

        const rem = Math.max(0, Math.ceil(duration - elapsed));
        $('aivsai-clock').textContent = `${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')} remaining`;
        if (elapsed >= duration - 1e-6) finishDuel();
      }
      requestAnimationFrame(loop);
    }

    populateModels();
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAIVsAI);
  } else {
    mountAIVsAI();
  }
})();