"""Validate a folder using Harbor 0.22.0, independently of npm test."""
import argparse
import json
from typing import get_args
from pathlib import Path
from harbor.models.trajectories.agent import Agent
from harbor.models.trajectories.content import ContentPart, ImageSource
from harbor.models.trajectories.final_metrics import FinalMetrics
from harbor.models.trajectories.metrics import Metrics
from harbor.models.trajectories.observation import Observation
from harbor.models.trajectories.observation_result import ObservationResult
from harbor.models.trajectories.step import Step
from harbor.models.trajectories.subagent_trajectory_ref import SubagentTrajectoryRef
from harbor.models.trajectories.tool_call import ToolCall
from harbor.models.trajectories.trajectory import Trajectory
from harbor.utils.trajectory_validator import TrajectoryValidator

def maximal(version):
    """Populate every optional model field; recursion ends in one minimal child."""
    image = ContentPart(type="image", source=ImageSource(media_type="image/png", path="https://example.test/a.png"))
    child = Trajectory(trajectory_id="child", agent=Agent(name="child", version="1"),
                       steps=[Step(step_id=1, source="system", message="child")])
    ref = SubagentTrajectoryRef(trajectory_id="child", session_id="maximal", trajectory_path="child.json", extra={"note": "ref"})
    result = ObservationResult(source_call_id="t", content=[image], subagent_trajectory_ref=[ref], extra={"note": "result"})
    call = ToolCall(tool_call_id="t", function_name="read", arguments={"path": "a"}, extra={"timeout": 30})
    metrics = Metrics(prompt_tokens=3, completion_tokens=1, cached_tokens=0, cost_usd=0.1,
                      prompt_token_ids=[1, 2], completion_token_ids=[3], logprobs=[-0.5], extra={"request_id": "r"})
    turn = Step(step_id=1, timestamp="2026-11-03T10:00:00Z", source="agent", model_name="m",
                reasoning_effort=0.5, reasoning_content="think", is_copied_context=True, llm_call_count=1,
                message=[ContentPart(type="text", text="look"), image], tool_calls=[call],
                observation=Observation(results=[result]), metrics=metrics, extra={"note": "step"})
    dispatch = Step(step_id=2, source="agent", message="", is_copied_context=False, llm_call_count=0)
    model = Trajectory(schema_version=version, session_id="maximal", trajectory_id="parent",
        agent=Agent(name="fixture", version="1", model_name="m",
                    tool_definitions=[{"type": "function", "function": {"name": "read"}}], extra={"note": "agent"}),
        steps=[turn, dispatch], notes="All optional fields; deterministic dispatch uses a separate step.",
        continued_trajectory_ref="next.json", extra={"note": "root"}, subagent_trajectories=[child],
        final_metrics=FinalMetrics(total_steps=2, total_prompt_tokens=3, total_completion_tokens=1,
                                   total_cached_tokens=0, total_cost_usd=0.1, extra={"note": "final"}))
    # Guard the oracle against omissions when Harbor adds another optional field.
    instances = [model, model.agent, turn, dispatch, metrics, model.final_metrics,
                 turn.observation, result, ref, call, image, image.source, turn.message[0]]
    for cls in {type(item) for item in instances}:
        covered = set().union(*(item.model_dump(exclude_none=True).keys() for item in instances if type(item) is cls))
        assert covered == set(cls.model_fields), f"Unpopulated {cls.__name__} fields: {set(cls.model_fields) - covered}"
    return model

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("folder", type=Path, nargs="?")
parser.add_argument("--emit", type=Path, help="Build maximal fixtures with Harbor's own models")
args = parser.parse_args()
if args.emit:
    args.emit.mkdir(parents=True, exist_ok=True)
    for version in get_args(Trajectory.model_fields["schema_version"].annotation):
        model = maximal(version)
        file = args.emit / f"maximal-{version.removeprefix('ATIF-')}.json"
        file.write_text(json.dumps(model.model_dump(exclude_none=True, mode="json"), indent=2) + "\n")
folder = args.emit or args.folder
if folder is None:
    parser.error("provide a folder or --emit <folder>")
files = sorted(folder.glob("*.json"))
if not files:
    parser.error("folder contains no *.json files")
failed = False
for file in files:
    validator = TrajectoryValidator()
    try:
        valid = validator.validate(file)
        errors = validator.errors
    except Exception as error:
        valid, errors = False, [str(error)]
    print(f"{file}: {'VALID' if valid else 'INVALID'}")
    for error in errors:
        print(f"  {error}")
    failed |= not valid
raise SystemExit(1 if failed else 0)
