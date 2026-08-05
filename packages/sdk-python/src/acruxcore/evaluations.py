"""Evaluations namespaces: datasets, experiments, runs, optimize."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Optional
from urllib.parse import quote

if TYPE_CHECKING:
    from .client import AcruxCore

from .eval_types import (
    BuildFromFeedbackResult,
    CandidateDetail,
    DatasetDto,
    DatasetExampleDto,
    DatasetWithExamples,
    ExperimentDto,
    PromoteResult,
    RunCellDetailDto,
    RunDetailDto,
    RunListResponse,
    RunReport,
    StartOptimizeResult,
    StartRunResult,
)


class DatasetsNamespace:
    """``client.datasets`` — create, list, get, update, and delete datasets."""

    def __init__(self, client: "AcruxCore") -> None:
        self._client = client

    async def create(
        self,
        name: str,
        *,
        overall_feedback: Optional[str] = None,
    ) -> DatasetDto:
        body: Dict[str, Any] = {"name": name}
        if overall_feedback is not None:
            body["overall_feedback"] = overall_feedback
        response = await self._client._request(
            "POST", "/datasets", body, "creating dataset"
        )
        return DatasetDto.from_dict(
            self._client._parse_json_or_throw(response, "creating dataset")
        )

    async def build_from_feedback(
        self,
        name: str,
        feedback_ids: List[str],
        *,
        overall_feedback: Optional[str] = None,
    ) -> BuildFromFeedbackResult:
        body: Dict[str, Any] = {
            "name": name,
            "feedback_ids": feedback_ids,
        }
        if overall_feedback is not None:
            body["overall_feedback"] = overall_feedback
        response = await self._client._request(
            "POST", "/datasets/from-feedback", body, "building dataset from feedback"
        )
        return BuildFromFeedbackResult.from_dict(
            self._client._parse_json_or_throw(
                response, "building dataset from feedback"
            )
        )

    async def list(self) -> List[DatasetDto]:
        response = await self._client._request(
            "GET", "/datasets", None, "listing datasets"
        )
        data = self._client._parse_json_or_throw(response, "listing datasets")
        return [DatasetDto.from_dict(item) for item in (data.get("data") or [])]

    async def get(self, dataset_id: str) -> DatasetWithExamples:
        response = await self._client._request(
            "GET",
            f"/datasets/{quote(dataset_id, safe='')}",
            None,
            "getting dataset",
        )
        return DatasetWithExamples.from_dict(
            self._client._parse_json_or_throw(response, "getting dataset")
        )

    async def update(
        self,
        dataset_id: str,
        **kwargs: Any,
    ) -> DatasetDto:
        body: Dict[str, Any] = {}
        if "name" in kwargs:
            body["name"] = kwargs["name"]
        if "overall_feedback" in kwargs:
            body["overall_feedback"] = kwargs["overall_feedback"]
        response = await self._client._request(
            "PATCH",
            f"/datasets/{quote(dataset_id, safe='')}",
            body,
            "updating dataset",
        )
        return DatasetDto.from_dict(
            self._client._parse_json_or_throw(response, "updating dataset")
        )

    async def delete(self, dataset_id: str) -> None:
        await self._client._request(
            "DELETE",
            f"/datasets/{quote(dataset_id, safe='')}",
            None,
            "deleting dataset",
        )

    async def add_example(
        self,
        dataset_id: str,
        input: Dict[str, Any],
        *,
        criteria: Optional[str] = None,
        history: Optional[List[Dict[str, Any]]] = None,
    ) -> DatasetExampleDto:
        body: Dict[str, Any] = {"input": input}
        if criteria is not None:
            body["criteria"] = criteria
        if history is not None:
            body["history"] = history
        response = await self._client._request(
            "POST",
            f"/datasets/{quote(dataset_id, safe='')}/examples",
            body,
            "adding example",
        )
        return DatasetExampleDto.from_dict(
            self._client._parse_json_or_throw(response, "adding example")
        )

    async def remove_example(
        self, dataset_id: str, example_id: str
    ) -> None:
        await self._client._request(
            "DELETE",
            f"/datasets/{quote(dataset_id, safe='')}/examples/{quote(example_id, safe='')}",
            None,
            "removing example",
        )


class ExperimentsNamespace:
    """``client.experiments`` — create, list, get experiments and start runs."""

    def __init__(self, client: "AcruxCore") -> None:
        self._client = client

    async def create(
        self,
        dataset_id: str,
        version_ids: List[str],
        models: List[str],
        *,
        prompt_id: Optional[str] = None,
        name: Optional[str] = None,
        alias: Optional[str] = None,
    ) -> ExperimentDto:
        body: Dict[str, Any] = {
            "dataset_id": dataset_id,
            "version_ids": version_ids,
            "models": models,
        }
        if prompt_id is not None:
            body["prompt_id"] = prompt_id
        if name is not None:
            body["name"] = name
        if alias is not None:
            body["alias"] = alias
        response = await self._client._request(
            "POST", "/experiments", body, "creating experiment"
        )
        return ExperimentDto.from_dict(
            self._client._parse_json_or_throw(response, "creating experiment")
        )

    async def list(self) -> List[ExperimentDto]:
        response = await self._client._request(
            "GET", "/experiments", None, "listing experiments"
        )
        data = self._client._parse_json_or_throw(response, "listing experiments")
        return [ExperimentDto.from_dict(item) for item in (data.get("data") or [])]

    async def get(self, experiment_id: str) -> ExperimentDto:
        response = await self._client._request(
            "GET",
            f"/experiments/{quote(experiment_id, safe='')}",
            None,
            "getting experiment",
        )
        return ExperimentDto.from_dict(
            self._client._parse_json_or_throw(response, "getting experiment")
        )

    async def start_run(self, experiment_id: str) -> StartRunResult:
        response = await self._client._request(
            "POST",
            f"/experiments/{quote(experiment_id, safe='')}/runs",
            None,
            "starting run",
        )
        return StartRunResult.from_dict(
            self._client._parse_json_or_throw(response, "starting run")
        )


class RunsNamespace:
    """``client.runs`` — list, get, read reports, inspect cells, promote candidates."""

    def __init__(self, client: "AcruxCore") -> None:
        self._client = client

    async def list(
        self,
        *,
        status: Optional[str] = None,
        dataset_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
        page: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> RunListResponse:
        params: Dict[str, str] = {}
        if status:
            params["status"] = status
        if dataset_id:
            params["dataset_id"] = dataset_id
        if prompt_id:
            params["prompt_id"] = prompt_id
        if page is not None:
            params["page"] = str(page)
        if limit is not None:
            params["limit"] = str(limit)
        qs = "&".join(f"{k}={v}" for k, v in params.items()) if params else ""
        path = f"/runs?{qs}" if qs else "/runs"
        response = await self._client._request(
            "GET", path, None, "listing runs"
        )
        return RunListResponse.from_dict(
            self._client._parse_json_or_throw(response, "listing runs")
        )

    async def get(self, run_id: str) -> RunDetailDto:
        response = await self._client._request(
            "GET",
            f"/runs/{quote(run_id, safe='')}",
            None,
            "getting run",
        )
        return RunDetailDto.from_dict(
            self._client._parse_json_or_throw(response, "getting run")
        )

    async def get_report(self, run_id: str) -> RunReport:
        response = await self._client._request(
            "GET",
            f"/runs/{quote(run_id, safe='')}/report",
            None,
            "getting run report",
        )
        return RunReport.from_dict(
            self._client._parse_json_or_throw(response, "getting run report")
        )

    async def get_cell(self, run_id: str, cell_key: str) -> RunCellDetailDto:
        response = await self._client._request(
            "GET",
            f"/runs/{quote(run_id, safe='')}/cells/{quote(cell_key, safe='')}",
            None,
            "getting run cell",
        )
        return RunCellDetailDto.from_dict(
            self._client._parse_json_or_throw(response, "getting run cell")
        )

    async def get_candidate(
        self, run_id: str, candidate_id: str
    ) -> CandidateDetail:
        response = await self._client._request(
            "GET",
            f"/runs/{quote(run_id, safe='')}/candidates/{quote(candidate_id, safe='')}",
            None,
            "getting candidate",
        )
        return CandidateDetail.from_dict(
            self._client._parse_json_or_throw(response, "getting candidate")
        )

    async def promote_candidate(
        self,
        run_id: str,
        prompt_candidate_id: str,
        *,
        alias: Optional[str] = None,
    ) -> PromoteResult:
        body: Dict[str, Any] = {"prompt_candidate_id": prompt_candidate_id}
        if alias is not None:
            body["alias"] = alias
        response = await self._client._request(
            "POST",
            f"/runs/{quote(run_id, safe='')}/promote",
            body,
            "promoting candidate",
        )
        return PromoteResult.from_dict(
            self._client._parse_json_or_throw(response, "promoting candidate")
        )


class OptimizeNamespace:
    """``client.optimize`` — start prompt optimization runs."""

    def __init__(self, client: "AcruxCore") -> None:
        self._client = client

    async def start(
        self,
        prompt_id: str,
        dataset_id: str,
        models: List[str],
        *,
        draft_count: Optional[int] = None,
        alias: Optional[str] = None,
    ) -> StartOptimizeResult:
        body: Dict[str, Any] = {
            "dataset_id": dataset_id,
            "models": models,
        }
        if draft_count is not None:
            body["draft_count"] = draft_count
        if alias is not None:
            body["alias"] = alias
        response = await self._client._request(
            "POST",
            f"/prompts/{quote(prompt_id, safe='')}/optimize",
            body,
            "starting optimize",
        )
        return StartOptimizeResult.from_dict(
            self._client._parse_json_or_throw(response, "starting optimize")
        )
