# Call your provider directly with your own key (BYO)

Runnable scripts for the [Call your provider directly](https://docs.acruxcore.com/docs/guides/call-your-provider-directly) guide.

For each provider whose key you set, the script makes three calls with your own provider key:

1. A plain `chat()` call.
2. The same call, streamed.
3. A tool loop. The model calls `get_weather` for Paris and Rome, the tool runs on your machine, and the model answers.
   The tool is defined with `@acrux.tool` in Python and `acrux.tool()` with a zod schema in Node.

The SDK sends each call to the provider itself and reports it to AcruxCore as a trace. OpenAI and
OpenRouter use the OpenAI Chat Completions format. Anthropic and Gemini use their own APIs (Messages
and `generateContent`). The AcruxCore key never calls a model; it only sends the traces.

## Prerequisites

- An AcruxCore API key. No model or credential needs to be stored in AcruxCore.
- A key for at least one provider. A provider without a key is skipped.
- Python 3.9+ or Node 18+.
- The `anthropic` and `gemini` kinds need an SDK release after 0.21.0.

## Setup

```bash
export ACRUXCORE_API_KEY=acx_sk_...
export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1   # the default; set it for a self-hosted instance

export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export GEMINI_API_KEY=AIza...
export OPENROUTER_API_KEY=sk-or-...

# Optional: a different model for one provider, e.g. GEMINI_MODEL=gemini-3.5-flash
```

## Python

```bash
cd python
pip install acruxcore
python call_providers.py
```

## TypeScript / Node

```bash
cd typescript
npm install @acruxcoreai/sdk zod
node call_providers.mjs
```

## Output

A real run of the Python script:

```text
== openai (gpt-4o-mini)
  chat:   'Hello! How are you today?'  (13+7 tokens)
  stream: 'Hello! How are you today?'
  tools:  'The weather is 18°C in Paris and 24°C in Rome.'  (2 tool calls, 2 model turns)
== anthropic (claude-haiku-4-5)
  chat:   'Hello, how are you today?'  (13+10 tokens)
  stream: 'Hello, how are you today?'
  tools:  'Paris is currently 18°C while Rome is warmer at 24°C.'  (2 tool calls, 2 model turns)
== gemini (gemini-3-flash-preview)
  chat:   'Hello, how are you today?'  (7+251 tokens)
  stream: 'Hello, how are you doing?'
  tools:  'It is currently 18°C in Paris and 24°C in Rome.'  (2 tool calls, 2 model turns)
== openrouter (openai/gpt-4o-mini)
  chat:   'Hello there, how are you?'  (13+7 tokens)
  stream: 'Hello! How are you today?'
  tools:  'The weather is 18°C in Paris and 24°C in Rome.'  (2 tool calls, 2 model turns)
Done. Each call is a trace under Traces in the dashboard.
```

The TypeScript script prints the same lines. Gemini's completion tokens include its thinking
tokens, so its count is larger than the length of the answer suggests. A provider whose key is
wrong, or whose quota is used up, prints `failed:` with the provider's error, and the script
moves on to the next provider.
