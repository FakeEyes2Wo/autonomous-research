# Early-Exit Fairness — Cycle-1 Evidence (run-early-exit)

Real WinoBias type1 (pro=stereotype-consistent/clean, anti=stereotype-violating/conflict), split BY OCCUPATION into clean-calibration and unseen-conflictive occupation subsets. Adaptive-depth model: per-layer option-confidence gate (training-free per-layer LM head is the reportable signal; the trained per-layer heads are reported separately). Groups = pronoun gender {he, she}; referent occupation stereotype gender {M, F} is a secondary axis.

```
backbones = ['Qwen/Qwen2.5-0.5B-Instruct', 'Qwen/Qwen2.5-1.5B-Instruct']
headline tau = 0.6 · seed 42 · type1
```

### Qwen/Qwen2.5-0.5B-Instruct

**Full-depth reference (no exit):** clean_unseen=0.58333, conflict_unseen=0.50641, conflict_seen=0.44516

**Trained-head confidence vs depth (clean_unseen):**
| layer | mean_conf | pct>=0.60 | pct>=0.75 |
|---|---|---|---|
| 6 | 0.5448 | 0.08333 | 0.0 |
| 12 | 0.5779 | 0.3141 | 0.01282 |
| 18 | 0.6621 | 0.67949 | 0.21154 |
| 24 | 0.7772 | 0.85256 | 0.5641 |

**Shared gate (tau=0.60) per-group, clean vs conflict:**
*clean_unseen* (wgs_depth=0.53648)
| group | n | mean_depth | exit_acc | ece | brier |
|---|---|---|---|---|---|
| he | 80 | 16.875 | 0.4625 | 0.2249 | 0.28001 |
| she | 76 | 17.9211 | 0.71053 | 0.19678 | 0.24204 |

*conflict_unseen* (wgs_depth=0.6579)
| group | n | mean_depth | exit_acc | ece | brier |
|---|---|---|---|---|---|
| she | 80 | 16.875 | 0.4375 | 0.27877 | 0.29572 |
| he | 76 | 18.1579 | 0.65789 | 0.19833 | 0.2631 |

**Stereotype gap (clean vs conflict exit-accuracy):**
| group | clean | conflict | gap |
|---|---|---|---|
| he | 0.4625 | 0.65789 | -0.19539 |
| she | 0.71053 | 0.4375 | 0.27303 |

**Referent stereotype-gender axis (exit-acc):**
*clean_unseen* (wgs_depth=0.53648)
| group | n | mean_depth | exit_acc | ece |
|---|---|---|---|---|
| M | 80 | 16.875 | 0.4625 | 0.2249 |
| F | 76 | 17.9211 | 0.71053 | 0.19678 |

*conflict_unseen* (wgs_depth=0.6579)
| group | n | mean_depth | exit_acc | ece |
|---|---|---|---|---|
| M | 80 | 16.875 | 0.4375 | 0.27877 |
| F | 76 | 18.1579 | 0.65789 | 0.19833 |

**Per-group calibration (RC2 first cut):**
| group | fitted_temp | clean_ECE |
|---|---|---|
| he | 3.0 | 0.15536 |
| she | 0.4 | 0.09733 |

**After per-group temperature scaling (conflict_unseen):**
| group | n | mean_depth | exit_acc | ece |
|---|---|---|---|---|
| she | 80 | 10.8 | 0.3625 | 0.3437 |
| he | 76 | 23.3684 | 0.40789 | 0.21156 |


### Qwen/Qwen2.5-1.5B-Instruct

**Full-depth reference (no exit):** clean_unseen=0.73718, conflict_unseen=0.48077, conflict_seen=0.36129

**Trained-head confidence vs depth (clean_unseen):**
| layer | mean_conf | pct>=0.60 | pct>=0.75 |
|---|---|---|---|
| 7 | 0.7508 | 0.80769 | 0.53846 |
| 14 | 0.7769 | 0.82051 | 0.55128 |
| 21 | 0.8704 | 0.9359 | 0.76923 |
| 28 | 0.8017 | 0.84615 | 0.64103 |

**Shared gate (tau=0.60) per-group, clean vs conflict:**
*clean_unseen* (wgs_depth=0.1842)
| group | n | mean_depth | exit_acc | ece | brier |
|---|---|---|---|---|---|
| he | 80 | 8.925 | 0.6875 | 0.12748 | 0.22017 |
| she | 76 | 8.5658 | 0.30263 | 0.48253 | 0.48215 |

*conflict_unseen* (wgs_depth=0.04487)
| group | n | mean_depth | exit_acc | ece | brier |
|---|---|---|---|---|---|
| she | 80 | 8.6625 | 0.6625 | 0.15821 | 0.23655 |
| he | 76 | 8.75 | 0.28947 | 0.50158 | 0.49528 |

**Stereotype gap (clean vs conflict exit-accuracy):**
| group | clean | conflict | gap |
|---|---|---|---|
| he | 0.6875 | 0.28947 | 0.39803 |
| she | 0.30263 | 0.6625 | -0.35987 |

**Referent stereotype-gender axis (exit-acc):**
*clean_unseen* (wgs_depth=0.1842)
| group | n | mean_depth | exit_acc | ece |
|---|---|---|---|---|
| M | 80 | 8.925 | 0.6875 | 0.12748 |
| F | 76 | 8.5658 | 0.30263 | 0.48253 |

*conflict_unseen* (wgs_depth=0.04487)
| group | n | mean_depth | exit_acc | ece |
|---|---|---|---|---|
| M | 80 | 8.6625 | 0.6625 | 0.15821 |
| F | 76 | 8.75 | 0.28947 | 0.50158 |

**Per-group calibration (RC2 first cut):**
| group | fitted_temp | clean_ECE |
|---|---|---|
| he | 1.5 | 0.04698 |
| she | 3.0 | 0.33953 |

**After per-group temperature scaling (conflict_unseen):**
| group | n | mean_depth | exit_acc | ece |
|---|---|---|---|---|
| she | 80 | 14.35 | 0.6375 | 0.07608 |
| he | 76 | 10.2237 | 0.26316 | 0.47504 |


# Cross-backbone comparison (tau=0.60)

| model | split | group | n | mean_depth | exit_acc | ece | wgs | full_depth_acc |
|---|---|---|---|---|---|---|---|---|
| Qwen/Qwen2.5-0.5B-Instruct | clean_unseen | he | 80 | 16.875 | 0.4625 | 0.2249 | 0.53648 | 0.58333 |
| Qwen/Qwen2.5-0.5B-Instruct | clean_unseen | she | 76 | 17.9211 | 0.71053 | 0.19678 | 0.53648 | 0.58333 |
| Qwen/Qwen2.5-0.5B-Instruct | conflict_unseen | she | 80 | 16.875 | 0.4375 | 0.27877 | 0.6579 | 0.50641 |
| Qwen/Qwen2.5-0.5B-Instruct | conflict_unseen | he | 76 | 18.1579 | 0.65789 | 0.19833 | 0.6579 | 0.50641 |
| Qwen/Qwen2.5-1.5B-Instruct | clean_unseen | he | 80 | 8.925 | 0.6875 | 0.12748 | 0.1842 | 0.73718 |
| Qwen/Qwen2.5-1.5B-Instruct | clean_unseen | she | 76 | 8.5658 | 0.30263 | 0.48253 | 0.1842 | 0.73718 |
| Qwen/Qwen2.5-1.5B-Instruct | conflict_unseen | she | 80 | 8.6625 | 0.6625 | 0.15821 | 0.04487 | 0.48077 |
| Qwen/Qwen2.5-1.5B-Instruct | conflict_unseen | he | 76 | 8.75 | 0.28947 | 0.50158 | 0.04487 | 0.48077 |

