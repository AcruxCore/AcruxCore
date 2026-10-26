import { describe, expect, it } from 'vitest';
import { pipelineTestSnippets } from './pipeline-test-snippet';

describe('pipelineTestSnippets', () => {
  const input = {
    datasetId: 'ds-1',
    judgeModel: 'gpt-4o-mini',
    judgePromptId: null,
    judgePromptVersion: null,
    judgePromptLost: false,
    runModel: 'glm-5.3',
    promptName: 'support-agent',
    versionNumber: 7,
    label: 'candidate-B',
  };

  it('pins the committed version under the prompt name, beside an unpinned production run', () => {
    const { python, node } = pipelineTestSnippets(input);
    expect(python).toContain('"candidate-B": {"support-agent": 7}');
    expect(python).toContain('"production": None');
    expect(python).toContain('hub.experiments.judge("gpt-4o-mini")');
    expect(node).toContain('"candidate-B": { "support-agent": 7 }');
    expect(node).toContain("compareLocal(\"ds-1\"");
  });

  it('quotes a prompt name that would break the code', () => {
    const { python } = pipelineTestSnippets({ ...input, promptName: 'say "hi"' });
    expect(python).toContain('{"say \\"hi\\"": 7}');
  });

  it('judges with the model the run scored with when the run recorded no judge', () => {
    // That model was registered on the team when the run ran; a fixed default may not be.
    const { python, node } = pipelineTestSnippets({ ...input, judgeModel: null });
    expect(python).toContain('judge("glm-5.3")');
    expect(python).toContain('# This run did not record its judge');
    expect(node).toContain('judge("glm-5.3")');
    expect(node).toContain('// This run did not record its judge');
    expect(python).not.toContain('gpt-4o-mini');
  });

  it('grades with the run\'s custom judge prompt when it had one', () => {
    const { python, node } = pipelineTestSnippets({ ...input, judgePromptId: 'jp-1' });
    expect(python).toContain('hub.experiments.judge("gpt-4o-mini", judge_prompt_id="jp-1")');
    expect(node).toContain('hub.experiments.judge("gpt-4o-mini", { judgePromptId: "jp-1" })');
  });

  it('names the judge prompt version the run graded with', () => {
    const { python, node } = pipelineTestSnippets({ ...input, judgePromptId: 'jp-1', judgePromptVersion: 3 });
    expect(python).toContain('judge("gpt-4o-mini", judge_prompt_id="jp-1", judge_prompt_version=3)');
    expect(node).toContain('judge("gpt-4o-mini", { judgePromptId: "jp-1", judgePromptVersion: 3 })');
  });

  it('says the scores will not compare when the run\'s judge prompt can no longer be read', () => {
    const { python, node } = pipelineTestSnippets({ ...input, judgePromptLost: true });
    expect(python).toContain('# This run graded with a judge prompt that can no longer be read');
    expect(node).toContain('// This run graded with a judge prompt that can no longer be read');
    expect(python).toContain('hub.experiments.judge("gpt-4o-mini")');
  });

  it('runs as a plain Python script: the async code sits inside a function asyncio.run calls', () => {
    const { python } = pipelineTestSnippets(input);
    expect(python).not.toMatch(/^async with/m);
    expect(python).toContain('async def main():');
    expect(python).toMatch(/^asyncio\.run\(main\(\)\)$/m);
  });
});
