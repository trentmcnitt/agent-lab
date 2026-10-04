"""Every OpenTelemetry name Agent Lab writes, in one place (SPEC.md section 8).

Nothing else in the library, and nothing in a framework integration, types an `agentlab.*` or
`gen_ai.*` string: they import it from here. The bench's reader (`adapters/otlp.py`) mirrors these
names; SPEC.md section 8 is the contract between the two.

GenAI names follow open-telemetry/semantic-conventions-genai (Development status), the same commit
the bench's adapter is verified against.
"""
from __future__ import annotations

SCOPE = "agentlab"

# The common four, on every Agent Lab span and every span the stamping processor touches.
APP = "agentlab.app"
RUN = "agentlab.run"
NODE = "agentlab.node"
KIND = "agentlab.kind"

# agentlab.kind values
KIND_RUN = "run"
KIND_MANIFEST = "manifest"
KIND_NODE = "node"
KIND_CHAT = "chat"
KIND_RETRIEVAL = "retrieval"
KIND_TOOL = "tool"

# Run span
CONTENT_MODE = "agentlab.content_mode"
MANIFEST = "agentlab.manifest"
MANIFEST_HASH = "agentlab.manifest.hash"
THREAD = "agentlab.thread"
RUN_RESUME = "agentlab.run.resume"
RUN_STATUS = "agentlab.run.status"
RUN_OUTCOME = "agentlab.run.outcome"
RUN_INPUT = "agentlab.run.input"
RUN_OUTPUT = "agentlab.run.output"
SESSION_ID = "session.id"

# Node span
STEP = "agentlab.step"
NS = "agentlab.ns"

# Chat and retrieval spans (beyond GenAI)
REQUEST_JSON_SCHEMA = "agentlab.request.json_schema"
COST_USD = "agentlab.cost.usd"
COST_BASIS = "agentlab.cost.basis"
CORPUS_HASH = "agentlab.corpus.hash"

# Span events and their attributes
EV_DECISION = "agentlab.decision"
DECISION_REASON = "agentlab.decision.reason"
DECISION_CITED = "agentlab.decision.cited"
DECISION_BRANCH = "agentlab.decision.branch"
DECISION_CONFIDENCE = "agentlab.decision.confidence"

EV_CHECK = "agentlab.check"
CHECK_NAME = "agentlab.check.name"
CHECK_PASSED = "agentlab.check.passed"
CHECK_DETAIL = "agentlab.check.detail"
CHECK_EVIDENCE = "agentlab.check.evidence"
CHECK_KIND = "agentlab.check.kind"
CHECK_WORDS = "agentlab.check.words"

EV_GATE_WAITING = "agentlab.gate.waiting"
EV_GATE_RESOLVED = "agentlab.gate.resolved"
GATE_PROPOSED = "agentlab.gate.proposed"
GATE_REASON = "agentlab.gate.reason"
GATE_APPROVED = "agentlab.gate.approved"
GATE_BY = "agentlab.gate.by"

EV_EVENT = "agentlab.event"
EVENT_TYPE = "agentlab.event.type"
EVENT_DATA = "agentlab.event.data"

# GenAI semantic conventions
GEN_AI_OPERATION = "gen_ai.operation.name"
GEN_AI_PROVIDER = "gen_ai.provider.name"
GEN_AI_REQUEST_MODEL = "gen_ai.request.model"
GEN_AI_RESPONSE_MODEL = "gen_ai.response.model"
GEN_AI_INPUT_TOKENS = "gen_ai.usage.input_tokens"
GEN_AI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
GEN_AI_CACHE_READ = "gen_ai.usage.cache_read.input_tokens"
GEN_AI_CACHE_WRITE = "gen_ai.usage.cache_write.input_tokens"
GEN_AI_FINISH_REASONS = "gen_ai.response.finish_reasons"
GEN_AI_SYSTEM = "gen_ai.system_instructions"
GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages"
GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages"
GEN_AI_DATA_SOURCE = "gen_ai.data_source.id"
GEN_AI_RETRIEVAL_QUERY = "gen_ai.retrieval.query.text"
GEN_AI_RETRIEVAL_DOCUMENTS = "gen_ai.retrieval.documents"
GEN_AI_TOOL_NAME = "gen_ai.tool.name"
GEN_AI_TOOL_CALL_ID = "gen_ai.tool.call.id"
GEN_AI_TOOL_CALL_ARGUMENTS = "gen_ai.tool.call.arguments"
GEN_AI_TOOL_CALL_RESULT = "gen_ai.tool.call.result"

# Attributes whose values are content (the user's input, a document, the model's words). Agent Lab
# applies `redact` to them as it emits them, omits them with capture_content=False, and the masking
# exporter applies `redact` to other instrumentors' copies (shared mode) before they reach the bench.
# Prefixes cover OpenInference's flattened message and document attributes.
CONTENT_ATTRIBUTES = frozenset({
    RUN_INPUT, RUN_OUTPUT,
    GEN_AI_SYSTEM, GEN_AI_INPUT_MESSAGES, GEN_AI_OUTPUT_MESSAGES,
    GEN_AI_RETRIEVAL_QUERY, GEN_AI_RETRIEVAL_DOCUMENTS,
    GEN_AI_TOOL_CALL_ARGUMENTS, GEN_AI_TOOL_CALL_RESULT,
    DECISION_REASON, CHECK_DETAIL, GATE_PROPOSED, GATE_REASON, EVENT_DATA,
    "input.value", "output.value", "pydantic_ai.all_messages",
})
CONTENT_PREFIXES = ("llm.input_messages.", "llm.output_messages.", "retrieval.documents.",
                    "llm.prompts.", "gen_ai.prompt.", "gen_ai.completion.")


def is_content(key: str) -> bool:
    return key in CONTENT_ATTRIBUTES or key.startswith(CONTENT_PREFIXES)
