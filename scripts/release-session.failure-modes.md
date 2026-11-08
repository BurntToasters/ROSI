# Release quality-gate proof: scenario inventory failure modes

`verifyFullE2eEvidence` in `scripts/release-session.js` decides whether a full
E2E report can back a release proof. These rows cover the expected-scenario
inventory it compares against.

| #   | Failure mode                                                                                                                                          | Required behavior                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The proof compares the report with the static manifest list only, while the full gate also expects one `v5-fixes/<area>` scenario per discovered area | A passing full report is rejected forever. The proof must use the same full-suite list the gate builds (`e2eRunPlan` with the discovered areas). |
| 2   | A `v5-fixes` area is added or removed after the report was written                                                                                    | The discovered list no longer equals the report's list, so the proof is refused. The report must be re-run on the current tree.                  |
| 3   | The report omits an area scenario or reports one twice                                                                                                | `scenarioOutcomeProblems` with the full list reports it, and the proof is refused.                                                               |
| 4   | A report from `ROSI_E2E_ONLY` or a `--group` run is offered as proof                                                                                  | Still refused: such reports set `fullSuite: false` and carry a partial list.                                                                     |
| 5   | An area without a feature group in `e2e/suites.json` exists                                                                                           | `e2eRunPlan` throws, so neither the gate nor the proof accepts the tree until the area is mapped.                                                |
