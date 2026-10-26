"""Evaluations namespaces: datasets, experiments, runs, optimize."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, Iterable, List, Optional
from urllib.parse import quote

if TYPE_CHECKING:
    from .client import AcruxCore

from .eval_types import (
    AddExamplesResult,
    BuildFromFeedbackResult,
    CandidateDetail,
    CommitCandidateResult,
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
    RejudgeRunResult,
)
from .local_experiments import (
    LocalComparison,
    LocalRunResult,
    Score,
    compare_local_variants,
    make_judge_scorer,
    run_local_experiment,
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
        expected: Any = None,
    ) -> DatasetExampleDto:
        """Add one example to a dataset.

        ``expected`` is an optional reference answer in any JSON shape, for code
        scorers in :meth:`ExperimentsNamespace.run_local`. The LLM judge does not read
        it; it keeps grading against ``criteria``. ``None`` leaves it unset.
        """
        body: Dict[str, Any] = {"input": input}
        if criteria is not None:
            body["criteria"] = criteria
        if history is not None:
            body["history"] = history
        if expected is not None:
            body["expected"] = expected
        response = await self._client._request(
            "POST",
            f"/datasets/{quote(dataset_id, safe='')}/examples",
            body,
            "adding example",
        )
        return DatasetExampleDto.from_dict(
            self._client._parse_json_or_throw(response, "adding example")
        )

    async def add_examples(
        self, dataset_id: str, examples: List[Dict[str, Any]]
    ) -> AddExamplesResult:
        """Import many examples in one request — a prepared test set from a file.

        Each item has the same keys as :meth:`add_example`: ``input`` (required),
        ``criteria``, ``history`` and ``expected`` (optional). All-or-nothing: one invalid row
        rejects the call with a 400 naming the row (``examples[17].input: ...``)
        and nothing is written. At most 500 rows per call.
        """
        response = await self._client._request(
            "POST",
            f"/datasets/{quote(dataset_id, safe='')}/examples/bulk",
            {"examples": examples},
            "adding examples",
        )
        return AddExamplesResult.from_dict(
            self._client._parse_json_or_throw(response, "adding examples")
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
        judge_model: str,
        prompt_id: Optional[str] = None,
        name: Optional[str] = None,
        alias: Optional[str] = None,
        judge_prompt_id: Optional[str] = None,
    ) -> ExperimentDto:
        """Create an experiment.

        ``judge_model`` is the model that grades every result: a model registered
        under Gateway → Models. It is required because the server has no default judge.

        ``judge_prompt_id`` is a prompt of yours that grades instead of the built-in
        judge. Each run uses its ``production`` version (else its latest).
        """
        body: Dict[str, Any] = {
            "dataset_id": dataset_id,
            "version_ids": version_ids,
            "models": models,
            "judge_model": judge_model,
        }
        if prompt_id is not None:
            body["prompt_id"] = prompt_id
        if name is not None:
            body["name"] = name
        if alias is not None:
            body["alias"] = alias
        if judge_prompt_id is not None:
            body["judge_prompt_id"] = judge_prompt_id
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

    async def delete(self, experiment_id: str) -> None:
        """Delete an experiment and every run under it.

        Raises a 409 ``RUN_IN_FLIGHT`` error while one of its runs is still
        queued or running — wait for it to settle, then delete.
        """
        await self._client._request(
            "DELETE",
            f"/experiments/{quote(experiment_id, safe='')}",
            None,
            "deleting experiment",
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


    async def run_local(
        self,
        dataset_id: str,
        *,
        task: Callable[..., Any],
        scorers: Iterable[Callable[..., Any]] = (),
        name: str,
        model: Optional[str] = None,
        primary_score: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        concurrency: int = 4,
        prompt_overrides: Optional[Dict[str, int]] = None,
    ) -> LocalRunResult:
        """Run your own code over a dataset and upload the outcome as a run.

        Use it when the thing under test is your app — several prompts, tool calls
        and plain code — rather than one stored prompt. The run appears under
        Evaluation → Runs and in Compare per example like a server-side run.

        ``task`` is called once per example, as ``task(input)`` or, when it takes two
        positional parameters, ``task(input, ctx)`` with a :class:`LocalExample`.
        Pass ``trace=ctx.trace`` to gateway calls so they join the example's trace.
        Sync functions run in a thread; async ones are awaited. A task that raises
        gives an errored result and its scorers are skipped; the run goes on.

        Each scorer gets only the keyword arguments it declares among ``output``,
        ``expected``, ``input``, ``criteria`` and ``example`` (all of them with
        ``**kwargs``). It returns a bool, a number in 0–1, a :class:`Score`, a dict
        ``{name?, score, passed?, reason?}``, or a list of those. Its name defaults to
        the function's ``__name__``. A scorer that raises, or returns a score outside
        0–1, gives a ``None`` score with the error as its reason.

        :param dataset_id: The dataset whose examples are frozen into the run.
        :param task: Your app, as a sync or async callable.
        :param scorers: Code scorers, run in order on every successful output.
        :param name: Labels the run (required, at most 100 characters, no ``|``).
        :param model: Free-text label for the run's cell (default ``"local"``). It is
            not checked against Gateway → Models, since the app may call any model.
        :param primary_score: The score the run list and report rank by. Omitted,
            each result's first score is used (the first scorer's, since scores keep
            scorer order). A named one must be on every scored result, or the upload
            is refused.
        :param metadata: Any JSON you want stored with the experiment, e.g. a git SHA.
        :param concurrency: Examples in flight at once (at least 1).
        :param prompt_overrides: ``{prompt_name: version_number}``. While the task
            runs, ``prompts.render`` and ``prompts.get_by_alias`` return that version
            for that prompt, whatever alias your code asks for — so your app runs on a
            version no alias points at yet, with no code change. The alias still
            decides the tools. Stored in the run's metadata.
        :returns: The run's id, URL, final status, every item and a per-score summary.
        :raises AcruxCoreError: Creating the run failed (unknown dataset, bad name),
            or results could not be uploaded after retries. When the loop fails this
            way, or is interrupted, the run is marked failed before the error is
            re-raised.
        """
        return await run_local_experiment(
            self._client,
            dataset_id,
            task=task,
            scorers=scorers,
            name=name,
            model=model,
            primary_score=primary_score,
            metadata=metadata,
            concurrency=concurrency,
            prompt_overrides=prompt_overrides,
        )

    async def compare_local(
        self,
        dataset_id: str,
        *,
        task: Callable[..., Any],
        variants: Dict[str, Optional[Dict[str, int]]],
        scorers: Iterable[Callable[..., Any]] = (),
        model: Optional[str] = None,
        primary_score: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        concurrency: int = 4,
    ) -> LocalComparison:
        """Run your app once per variant, at the same time, and compare them.

        Each variant is a name and its ``prompt_overrides`` (``None`` for none)::

            await hub.experiments.compare_local(
                dataset.id, task=agent, scorers=[hub.experiments.judge("gpt-4o-mini")],
                variants={"production": None, "candidate-B": {"support-agent": 7}},
            )

        Every variant becomes its own run, named after the variant. They run in
        parallel, so a vector store or database that changes over time changes for
        all of them alike, and the difference between the runs is the prompt.

        :param variants: ``{run_name: prompt_overrides}``, in order; the first is the
            baseline the compare links start from.
        :returns: One :class:`LocalRunResult` per variant, and a Compare per example
            link from the baseline to each other variant.
        :raises ValueError: ``variants`` is empty or holds an invalid version.
        :raises AcruxCoreError: A variant's run failed to create or upload.
        """
        return await compare_local_variants(
            self._client,
            dataset_id,
            task=task,
            scorers=scorers,
            variants=variants,
            model=model,
            primary_score=primary_score,
            metadata=metadata,
            concurrency=concurrency,
        )

    def judge(
        self,
        model: str,
        *,
        judge_prompt_id: Optional[str] = None,
        judge_prompt_version: Optional[int] = None,
        name: str = "judge",
    ) -> Callable[..., Awaitable[Score]]:
        """A scorer that grades each output with the LLM judge, for :meth:`run_local`.

        The judge runs on the server, against the example's ``criteria`` and the
        dataset's overall feedback as they were when the run started — the same
        rubric a server-side run or an optimize run grades with. So a dataset built
        from feedback can grade your whole app, not only one stored prompt.

        :param model: The judge model, a name under Gateway → Models.
        :param judge_prompt_id: Grade with one of your judge prompts instead.
        :param judge_prompt_version: The version of ``judge_prompt_id`` to grade with,
            instead of the one its ``production`` alias serves when the run's first
            output is graded. Pass the version an optimize run graded with, so a
            pipeline test's scores compare with the run's.
        :param name: The score's name (default ``"judge"``).
        :returns: An async scorer to put in ``scorers=``.
        :raises ValueError: When ``model`` is empty, or ``judge_prompt_version`` is
            given without ``judge_prompt_id``.
        """
        return make_judge_scorer(
            self._client,
            model,
            judge_prompt_id=judge_prompt_id,
            judge_prompt_version=judge_prompt_version,
            name=name,
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

    async def delete(self, run_id: str) -> None:
        """Delete one run and every cell it produced.

        The parent experiment and any optimizer candidates the run drafted are
        left alone. Raises a 409 ``RUN_IN_FLIGHT`` error while the run is still
        queued or running.
        """
        await self._client._request(
            "DELETE",
            f"/runs/{quote(run_id, safe='')}",
            None,
            "deleting run",
        )

    async def rejudge(self, run_id: str, *, only_unscored: bool = True) -> RejudgeRunResult:
        """Send a finished run's existing outputs back to its judge.

        The models under test are not called again, so only the judge calls are
        billed — the way to recover a run whose judge provider failed or ran out of
        quota. Grades with the judge, judge prompt version, criteria and overall
        feedback the run started with. Poll :meth:`get` until the run settles again.

        :param run_id: The run's id.
        :param only_unscored: Grade only results with no score (default). ``False``
            re-grades every result that has an output.
        :returns: The run's status and how many results were queued; ``rejudging=0``
            means nothing matched and the run was left as it was.
        :raises AcruxCoreError: With ``status_code`` 409 while the run is queued or
            running (the body's ``error.code`` is ``RUN_IN_FLIGHT``), when some cells
            never produced a result (``RUN_INCOMPLETE``), while one of its judge jobs
            is still retrying (``JUDGE_PENDING``), and for a local run
            (``LOCAL_EXPERIMENT``).
        """
        response = await self._client._request(
            "POST",
            f"/runs/{quote(run_id, safe='')}/rejudge",
            {"only_unscored": only_unscored},
            "re-judging run",
        )
        return RejudgeRunResult.from_dict(
            self._client._parse_json_or_throw(response, "re-judging run")
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

    async def commit_candidate(self, run_id: str, candidate_id: str) -> CommitCandidateResult:
        """Commit an optimizer candidate as a prompt version, without moving any alias.

        Use it to run your whole app on the candidate before promoting it: pass
        ``{result.prompt_name: result.version_number}`` as ``prompt_overrides``.
        Calling it again returns the same version, and a later
        :meth:`promote_candidate` moves the alias to that same version.

        :raises AcruxCoreError: 404 if the candidate is not from this run; 403 for a
            role below editor.
        """
        response = await self._client._request(
            "POST",
            f"/runs/{quote(run_id, safe='')}/candidates/{quote(candidate_id, safe='')}/commit",
            None,
            "committing candidate",
        )
        return CommitCandidateResult.from_dict(
            self._client._parse_json_or_throw(response, "committing candidate")
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
        judge_model: str,
        draft_count: Optional[int] = None,
        alias: Optional[str] = None,
        judge_prompt_id: Optional[str] = None,
        optimizer_model: Optional[str] = None,
    ) -> StartOptimizeResult:
        """Start an optimize run.

        ``judge_model`` is the model that grades every candidate and baseline result:
        a model registered under Gateway → Models. It is required because the server
        has no default judge.

        ``judge_prompt_id`` is a prompt of yours that grades instead of the built-in
        judge. The run uses its ``production`` version (else its latest), and the
        optimizer is shown it too.

        ``optimizer_model`` is the model that writes the rewrites, a name under Gateway
        → Models. Omitted, the first of ``models`` writes them.
        """
        body: Dict[str, Any] = {
            "dataset_id": dataset_id,
            "models": models,
            "judge_model": judge_model,
        }
        if draft_count is not None:
            body["draft_count"] = draft_count
        if alias is not None:
            body["alias"] = alias
        if judge_prompt_id is not None:
            body["judge_prompt_id"] = judge_prompt_id
        if optimizer_model is not None:
            body["optimizer_model"] = optimizer_model
        response = await self._client._request(
            "POST",
            f"/prompts/{quote(prompt_id, safe='')}/optimize",
            body,
            "starting optimize",
        )
        return StartOptimizeResult.from_dict(
            self._client._parse_json_or_throw(response, "starting optimize")
        )
