import AcruxCore, { acrux } from '@acruxcoreai/sdk';
import { z } from 'zod/v4';

const MODEL = 'support-model';

const getWeather = acrux.tool(
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: z.object({ city: z.string().describe("City name, e.g. 'London'") }),
  },
  async ({ city }) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
    if (!res.ok) throw new Error(`wttr.in returned ${res.status}`);
    const data = await res.json();
    const current = data.current_condition[0];
    return { city, tempC: Number(current.temp_C), summary: current.weatherDesc[0].value };
  },
);

const hub = new AcruxCore();

console.log('1. Tool-calling loop (declares + syncs get_weather)');
const toolResult = await hub.gateway.runToolLoop({
  model: MODEL,
  messages: [{ role: 'user', content: 'What is the weather in London right now?' }],
  tools: [getWeather],
});
console.log('  ->', toolResult.content);
console.log('  trace:', toolResult.traceId);

console.log('2. Non-streaming completion');
const chatResult = await hub.gateway.chat({ model: MODEL, messages: [{ role: 'user', content: 'Say hi in one word.' }] });
console.log('  ->', chatResult.content);

console.log('3. Streaming completion');
process.stdout.write('  -> ');
for await (const chunk of await hub.gateway.stream({ model: MODEL, messages: [{ role: 'user', content: 'Count to three.' }] })) {
  process.stdout.write(chunk.delta.content ?? '');
}
console.log();

console.log('4. Read the trace back and leave feedback');
await hub.gateway.flush();
const { trace } = await hub.traces.get(toolResult.traceId);
console.log('  status:', trace.status, 'cost:', trace.totalCostUsd);
const feedback = await hub.traces.submitFeedback({
  traceId: toolResult.traceId,
  rating: 1,
  label: 'weather-lookup-worked',
});
console.log('  feedback id:', feedback.id);
