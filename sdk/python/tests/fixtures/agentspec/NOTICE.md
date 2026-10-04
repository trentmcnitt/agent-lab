# Third-party test fixtures

The two `.yaml` files here are copied unmodified from Oracle's Open Agent Spec repository (https://github.com/oracle/agent-spec), commit `585b7516cff37c8ffb394f9e18b9492d4d765f03` (10-01-26), directory `pyagentspec/tests/agentspec_configs/`:

| file | why it is here |
|---|---|
| `example_serialized_flow_with_branching_node.yaml` | two `BranchingNode`s, three `EndNode`s, and edges whose `from_branch` (`yes`, `no`, `maybe`) differs in case from the branches the nodes declare (`Yes`, `No`, `Maybe`). Agent Lab reports that as R14; running this file through pyagentspec's LangGraph loader fails with `KeyError: 'Maybe'` (checked 10-03-26). |
| `flow_with_multiple_levels_of_references.yaml` | a `FlowNode` whose subflow has its own `$referenced_components` and also refers to a root-level component. |

Copyright © 2025 Oracle and/or its affiliates. The files are dual-licensed by Oracle under the Apache License 2.0 or the Universal Permissive License 1.0; Agent Lab uses them under the **Apache License 2.0**, whose text is in `LICENSE-APACHE.txt` beside this file. Each file keeps its original license header.
