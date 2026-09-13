/**
 * One weather tool, written two ways, against a real upstream that answers HTTP 200
 * when it has nothing to give you.
 *
 * Open-Meteo's geocoder returns 200 and a body with no `results` key when it cannot
 * place a city. The request succeeded. The tool call did not. Nothing outside this
 * function can tell those apart, which is what `toolError` exists for.
 *
 * Run it twice to see the difference:
 *
 *   node report_a_tool_failure.mjs            # the tool declares its own failures
 *   node report_a_tool_failure.mjs --silent   # the same tool, staying quiet
 *
 * Setup:
 *   npm install @acruxcoreai/sdk
 *   export ACRUXCORE_API_KEY=<your api key>
 *   export ACRUXCORE_BASE_URL=http://localhost:3001/api/v1
 *   export ACRUXCORE_MODEL=gpt-4o-mini-or
 */

import AcruxCore, { acrux, toolError, toolWarning } from '@acruxcoreai/sdk';

const MODEL = process.env.ACRUXCORE_MODEL ?? 'gpt-4o-mini-or';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Set by --silent. The tool body is otherwise identical, so the only variable
// between the two runs is whether the tool reports what it knows.
const SILENT = process.argv.includes('--silent');

const getWeatherBrief = acrux.tool(
  {
    name: 'get_weather_brief',
    description: 'Get the current temperature for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: "City name, for example 'Lahore'." } },
      required: ['city'],
    },
  },
  async ({ city }) => {
    const geo = await (
      await fetch(`${GEOCODE_URL}?name=${encodeURIComponent(city)}&count=5`)
    ).json();

    // The silent failure. HTTP 200, a well-formed body, and no city in it.
    const matches = geo.results ?? [];
    if (matches.length === 0) {
      const detail = `Open-Meteo has no coordinates for '${city}'.`;
      return SILENT ? { error: detail } : toolError('location_not_found', detail);
    }

    const place = matches[0];
    const forecast = await (
      await fetch(
        `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m`,
      )
    ).json();

    const reading = {
      city: place.name,
      country: place.country,
      temp_c: forecast.current.temperature_2m,
    };

    // Answered, but the name was ambiguous: Open-Meteo returns the most populous
    // match, so "Hyderabad" silently means the Indian one. Worth seeing on the
    // trace; not a failed run.
    const countries = [...new Set(matches.map((m) => m.country).filter(Boolean))].sort();
    if (countries.length > 1) {
      if (SILENT) return reading;
      return toolWarning(
        'ambiguous_city',
        `'${city}' matches places in ${countries.join(', ')}. ` +
          `Answered for ${place.name}, ${place.country}.`,
        reading,
      );
    }

    return reading;
  },
);

async function ask(hub, question, tag) {
  const run = await hub.gateway.runToolLoop({
    model: MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are a weather assistant. Always call the get_weather_brief tool, even for a ' +
          'place you believe is fictional — the tool is the only source of truth. If it ' +
          'cannot answer, say so plainly and never invent a temperature.',
      },
      { role: 'user', content: question },
    ],
    tools: [getWeatherBrief],
    trace: {
      name: 'weather-brief',
      tags: ['guide-tool-failure', SILENT ? 'silent' : 'declared', tag],
    },
  });
  console.log(`\nQ: ${question}`);
  console.log(`A: ${run.content}`);
  console.log(`   trace: ${run.traceId}`);
}

const hub = new AcruxCore();
console.log(`mode: ${SILENT ? 'SILENT (the tool keeps what it knows to itself)' : 'DECLARED'}`);
console.log(`model: ${MODEL}`);
await ask(hub, 'What is the weather in Kathmandu?', 'ok');
await ask(hub, 'What is the weather in Atlantis Prime?', 'not-found');
await ask(hub, 'What is the weather in Hyderabad?', 'ambiguous');
await hub.gateway.flush();
