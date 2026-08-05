"""Type definitions for the evaluations domain.

Wire-facing structures you *pass in* are plain dicts (camelCase keys).
Structures the SDK *returns* are ``dataclass``\\es with attribute access
and a ``from_dict`` builder that maps the API's camelCase JSON keys to
snake_case Python attributes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ── Dataset types ──


@dataclass
class DatasetDto:
    id: str
    team_id: str
    name: str
    overall_feedback: Optional[str]
    created_by: Optional[str]
    created_at: Optional[str]
    updated_at: Optional[str]
    example_count: int
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DatasetDto":
        return cls(
            id=d.get("id") or "",
            team_id=d.get("teamId") or "",
            name=d.get("name") or "",
            overall_feedback=d.get("overallFeedback"),
            created_by=d.get("createdBy"),
            created_at=d.get("createdAt"),
            updated_at=d.get("updatedAt"),
            example_count=d.get("exampleCount", 0),
            raw=d,
        )


@dataclass
class DatasetExampleDto:
    id: str
    dataset_id: str
    input: Dict[str, Any]
    criteria: Optional[str]
    history: Optional[List[Dict[str, Any]]]
    source_trace_id: Optional[str]
    source_feedback_id: Optional[str]
    source_prompt_version_id: Optional[str]
    created_at: Optional[str]
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DatasetExampleDto":
        return cls(
            id=d.get("id") or "",
            dataset_id=d.get("datasetId") or "",
            input=d.get("input") or {},
            criteria=d.get("criteria"),
            history=d.get("history"),
            source_trace_id=d.get("sourceTraceId"),
            source_feedback_id=d.get("sourceFeedbackId"),
            source_prompt_version_id=d.get("sourcePromptVersionId"),
            created_at=d.get("createdAt"),
            raw=d,
        )


@dataclass
class DatasetWithExamples(DatasetDto):
    examples: List[DatasetExampleDto] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DatasetWithExamples":
        return cls(
            id=d.get("id") or "",
            team_id=d.get("teamId") or "",
            name=d.get("name") or "",
            overall_feedback=d.get("overallFeedback"),
            created_by=d.get("createdBy"),
            created_at=d.get("createdAt"),
            updated_at=d.get("updatedAt"),
            example_count=d.get("exampleCount", 0),
            examples=[
                DatasetExampleDto.from_dict(e) for e in (d.get("examples") or [])
            ],
            raw=d,
        )


@dataclass
class BuildFromFeedbackResult:
    id: str
    name: str
    overall_feedback: Optional[str]
    example_count: int
    skipped: List[Dict[str, Any]] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "BuildFromFeedbackResult":
        return cls(
            id=d.get("id") or "",
            name=d.get("name") or "",
            overall_feedback=d.get("overall_feedback") or d.get("overallFeedback"),
            example_count=d.get("example_count", d.get("exampleCount", 0)),
            skipped=d.get("skipped") or [],
            raw=d,
        )


# ── Experiment types ──


@dataclass
class ExperimentRunDto:
    id: str
    experiment_id: str
    status: str
    started_at: Optional[str]
    ended_at: Optional[str]
    error: Optional[str]
    created_at: Optional[str]
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ExperimentRunDto":
        return cls(
            id=d.get("id") or "",
            experiment_id=d.get("experimentId") or "",
            status=d.get("status") or "",
            started_at=d.get("startedAt"),
            ended_at=d.get("endedAt"),
            error=d.get("error"),
            created_at=d.get("createdAt"),
            raw=d,
        )


@dataclass
class ExperimentDto:
    id: str
    team_id: str
    dataset_id: str
    prompt_id: Optional[str]
    name: Optional[str]
    config: Dict[str, Any]
    created_by: Optional[str]
    created_at: Optional[str]
    runs: List[ExperimentRunDto] = field(default_factory=list)
    prompt_mismatch_warning: Optional[Dict[str, Any]] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ExperimentDto":
        return cls(
            id=d.get("id") or "",
            team_id=d.get("teamId") or "",
            dataset_id=d.get("datasetId") or "",
            prompt_id=d.get("promptId"),
            name=d.get("name"),
            config=d.get("config") or {},
            created_by=d.get("createdBy"),
            created_at=d.get("createdAt"),
            runs=[
                ExperimentRunDto.from_dict(r) for r in (d.get("runs") or [])
            ],
            prompt_mismatch_warning=d.get("promptMismatchWarning"),
            raw=d,
        )


# ── Run types ──


@dataclass
class StartRunResult:
    run_id: str
    status: str
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "StartRunResult":
        return cls(
            run_id=d.get("run_id") or d.get("runId") or "",
            status=d.get("status") or "",
            raw=d,
        )


@dataclass
class RunListItemDto:
    id: str
    status: str
    kind: str
    experiment_id: str
    experiment_name: Optional[str]
    dataset_id: str
    dataset_name: str
    prompt_id: Optional[str]
    prompt_name: Optional[str]
    variant_count: int
    model_count: int
    example_count: int
    results: Dict[str, int]
    avg_score: Optional[float]
    pass_rate: Optional[float]
    top_variant_label: Optional[str]
    started_by: Optional[Dict[str, Any]]
    created_at: Optional[str]
    started_at: Optional[str]
    ended_at: Optional[str]
    duration_ms: Optional[int]
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RunListItemDto":
        return cls(
            id=d.get("id") or "",
            status=d.get("status") or "",
            kind=d.get("kind") or "evaluation",
            experiment_id=d.get("experimentId") or "",
            experiment_name=d.get("experimentName"),
            dataset_id=d.get("datasetId") or "",
            dataset_name=d.get("datasetName") or "",
            prompt_id=d.get("promptId"),
            prompt_name=d.get("promptName"),
            variant_count=d.get("variantCount", 0),
            model_count=d.get("modelCount", 0),
            example_count=d.get("exampleCount", 0),
            results=d.get("results") or {},
            avg_score=d.get("avgScore"),
            pass_rate=d.get("passRate"),
            top_variant_label=d.get("topVariantLabel"),
            started_by=d.get("startedBy"),
            created_at=d.get("createdAt"),
            started_at=d.get("startedAt"),
            ended_at=d.get("endedAt"),
            duration_ms=d.get("durationMs"),
            raw=d,
        )


@dataclass
class RunListResponse:
    data: List[RunListItemDto]
    total: int
    page: int
    limit: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RunListResponse":
        return cls(
            data=[RunListItemDto.from_dict(item) for item in (d.get("data") or [])],
            total=d.get("total", 0),
            page=d.get("page", 1),
            limit=d.get("limit", 20),
        )


@dataclass
class RunDetailDto:
    id: str
    experiment_id: str
    status: str
    started_at: Optional[str]
    ended_at: Optional[str]
    error: Optional[str]
    created_at: Optional[str]
    grid: List[Dict[str, Any]] = field(default_factory=list)
    example_count: int = 0
    results: Dict[str, int] = field(default_factory=dict)
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RunDetailDto":
        return cls(
            id=d.get("id") or "",
            experiment_id=d.get("experimentId") or "",
            status=d.get("status") or "",
            started_at=d.get("startedAt"),
            ended_at=d.get("endedAt"),
            error=d.get("error"),
            created_at=d.get("createdAt"),
            grid=d.get("grid") or [],
            example_count=d.get("exampleCount", 0),
            results=d.get("results") or {},
            raw=d,
        )


@dataclass
class RunReport:
    run_id: str
    status: str
    models: List[str]
    variants: List[Dict[str, Any]]
    cells: List[Dict[str, Any]]
    leaderboard: List[str]
    winner: Optional[Dict[str, Any]]
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RunReport":
        return cls(
            run_id=d.get("runId") or "",
            status=d.get("status") or "",
            models=d.get("models") or [],
            variants=d.get("variants") or [],
            cells=d.get("cells") or [],
            leaderboard=d.get("leaderboard") or [],
            winner=d.get("winner"),
            raw=d,
        )


@dataclass
class RunCellDetailDto:
    cell_key: str
    variant_label: str
    model: str
    examples: List[Dict[str, Any]] = field(default_factory=list)
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RunCellDetailDto":
        return cls(
            cell_key=d.get("cellKey") or "",
            variant_label=d.get("variantLabel") or "",
            model=d.get("model") or "",
            examples=d.get("examples") or [],
            raw=d,
        )


@dataclass
class CandidateDetail:
    id: str
    prompt_id: str
    messages: List[Dict[str, Any]]
    rationale: Optional[str]
    label: str
    created_at: Optional[str]
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CandidateDetail":
        return cls(
            id=d.get("id") or "",
            prompt_id=d.get("promptId") or "",
            messages=d.get("messages") or [],
            rationale=d.get("rationale"),
            label=d.get("label") or "",
            created_at=d.get("createdAt"),
            raw=d,
        )


@dataclass
class PromoteResult:
    version: Dict[str, Any]
    alias: Dict[str, Any]
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PromoteResult":
        return cls(
            version=d.get("version") or {},
            alias=d.get("alias") or {},
            raw=d,
        )


# ── Optimize types ──


@dataclass
class StartOptimizeResult:
    run_id: str
    status: str
    prompt_mismatch_warning: Optional[Dict[str, Any]] = None
    raw: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "StartOptimizeResult":
        return cls(
            run_id=d.get("run_id") or d.get("runId") or "",
            status=d.get("status") or "",
            prompt_mismatch_warning=d.get("prompt_mismatch_warning") or d.get("promptMismatchWarning"),
            raw=d,
        )
