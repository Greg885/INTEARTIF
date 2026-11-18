import matplotlib.pyplot as plt
from game import create_board
from algorithms import minimax, alphabeta, mcts


def benchmark(board, algorithm, label, **kwargs):
    """Exécute un algorithme sur un plateau donné et retourne ses métriques."""
    res = algorithm(board, **kwargs)
    return {
        "algorithm": label,
        "move": res["move"],
        "score": res["score"],
        "nodes_explored": res["nodes_explored"],
        "time": res["time"],
    }


def run_experiments():
    board = create_board()
    depths = [1, 2, 3, 4, 5]
    simulations_list = [100, 500, 1000, 2000]

    results = []
    minimax_nodes = []
    alphabeta_nodes = []
    mcts_times = []

    # 1. Comparaison Minimax vs Alpha-Beta (d in {1, 2, 3, 4, 5})
    for d in depths:
        res_mm = benchmark(board, minimax, "Minimax", depth=d)
        res_ab = benchmark(board, alphabeta, "Alpha-Beta", depth=d)

        # Vérifications demandées par l'énoncé
        assert res_mm["score"] == res_ab["score"], (
            f"Erreur à d={d}: scores différents ({res_mm['score']} vs {res_ab['score']})"
        )
        assert res_ab["nodes_explored"] <= res_mm["nodes_explored"], (
            f"Erreur à d={d}: Alpha-Beta a exploré plus de nœuds que Minimax"
        )

        results.append(("Minimax", f"Depth {d}", res_mm))
        results.append(("Alpha-Beta", f"Depth {d}", res_ab))

        minimax_nodes.append(res_mm["nodes_explored"])
        alphabeta_nodes.append(res_ab["nodes_explored"])

    # 2. Comparaison des budgets de simulation MCTS (N in {100, 500, 1000, 2000})
    for n in simulations_list:
        res_mcts = benchmark(board, mcts, "MCTS", num_simulations=n, seed=42)
        results.append(("MCTS", f"{n} simulations", res_mcts))
        mcts_times.append(res_mcts["time"])

    # 3. Affichage du tableau récapitulatif
    header = f"{'Algorithm':<12} | {'Configuration':<18} | {'Move':<6} | {'Score':<10} | {'Nodes':<8} | {'Time (s)':<10}"
    print(header)
    print("-" * len(header))
    for algo_name, config, r in results:
        print(
            f"{algo_name:<12} | {config:<18} | {r['move']:<6} | {str(r['score']):<10} | {r['nodes_explored']:<8} | {r['time']:<10.6f}"
        )

    # 4. Génération des graphiques avec Matplotlib (échelle logarithmique)
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 5))

    # Graphique 1 : Nœuds explorés vs Profondeur (Minimax vs Alpha-Beta)
    ax1.plot(depths, minimax_nodes, marker="o", label="Minimax", linewidth=2)
    ax1.plot(depths, alphabeta_nodes, marker="s", label="Alpha-Beta Pruning", linewidth=2)
    ax1.set_yscale("log")
    ax1.set_title("Nodes Explored vs. Search Depth (Log Scale)")
    ax1.set_xlabel("Search Depth (d)")
    ax1.set_ylabel("Nodes Explored (log scale)")
    ax1.set_xticks(depths)
    ax1.grid(True, which="both", linestyle="--", alpha=0.6)
    ax1.legend()

    # Graphique 2 : Temps d'exécution vs Nombre de simulations (MCTS)
    ax2.plot(simulations_list, mcts_times, marker="^", color="green", label="MCTS (seed=42)", linewidth=2)
    ax2.set_xscale("log")
    ax2.set_yscale("log")
    ax2.set_title("Execution Time vs. MCTS Simulations (Log-Log Scale)")
    ax2.set_xlabel("Number of Simulations (N) [log scale]")
    ax2.set_ylabel("Execution Time (s) [log scale]")
    ax2.set_xticks(simulations_list)
    ax2.get_xaxis().set_major_formatter(plt.ScalarFormatter())
    ax2.grid(True, which="both", linestyle="--", alpha=0.6)
    ax2.legend()

    plt.tight_layout()
    plt.savefig("benchmark_results_log.png", dpi=150)
    plt.show()


if __name__ == "__main__":
    run_experiments()