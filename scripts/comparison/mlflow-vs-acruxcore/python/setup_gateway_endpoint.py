"""Creates the OpenAI-backed MLflow AI Gateway endpoint that `latency_bench.py` posts to.

MLflow's AI Gateway is not a separate process — the `mlflow-server` container serves the
plain tracking server's Flask app, and `/gateway/mlflow/v1/chat/completions` returns a raw
Flask 404 until an endpoint actually exists. Neither the CLI nor a documented one-liner
creates one, so this script does it through the tracking store's REST client, which is the
only path that works headlessly.

Three calls, in order, because each returns the id the next one needs:

  create_gateway_secret            stores the provider key
  create_gateway_model_definition  binds that secret to a provider + model name
  create_gateway_endpoint          publishes the model under a routable endpoint name

Run:
  export OPENAI_API_KEY=sk-...
  export MLFLOW_TRACKING_URI=http://localhost:5000     # optional, this is the default
  python scripts/comparison/mlflow-vs-acruxcore/python/setup_gateway_endpoint.py

Re-running is safe: if the endpoint already exists the script reports it and exits 0
without creating a duplicate.

Needs: pip install mlflow
"""

import os
import sys

from mlflow.entities import GatewayEndpointModelConfig
from mlflow.store.tracking.rest_store import RestStore
from mlflow.utils.rest_utils import MlflowHostCreds

TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000")
ENDPOINT_NAME = os.environ.get("MLFLOW_ENDPOINT_NAME", "latency-bench")
# gpt-4o-mini, matching every other comparison benchmark, so the five numbers are
# directly comparable. The older `vip-support-triage` endpoint used gpt-4o only because
# MLflow's *OpenRouter* model picker offered no mini; a native OpenAI provider has it.
MODEL_NAME = os.environ.get("MLFLOW_MODEL_NAME", "gpt-4o-mini")
PROVIDER = "openai"

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    sys.exit("OPENAI_API_KEY is not set")


def main() -> None:
    store = RestStore(lambda: MlflowHostCreds(TRACKING_URI))

    existing = [e for e in store.list_gateway_endpoints() if e.name == ENDPOINT_NAME]
    if existing:
        print(f"endpoint {ENDPOINT_NAME!r} already exists — nothing to do")
        return

    secret = store.create_gateway_secret(
        secret_name=f"{ENDPOINT_NAME}-openai-key",
        secret_value={"api_key": OPENAI_API_KEY},
        provider=PROVIDER,
    )
    print(f"created secret {secret.secret_id}")

    model_def = store.create_gateway_model_definition(
        name=f"{ENDPOINT_NAME}-{MODEL_NAME}",
        secret_id=secret.secret_id,
        provider=PROVIDER,
        model_name=MODEL_NAME,
    )
    print(f"created model definition {model_def.model_definition_id}")

    endpoint = store.create_gateway_endpoint(
        name=ENDPOINT_NAME,
        model_configs=[GatewayEndpointModelConfig(model_definition_id=model_def.model_definition_id)],
    )
    print(f"created endpoint {endpoint.name!r} -> {PROVIDER}/{MODEL_NAME}")
    print(f"\nPOST {TRACKING_URI}/gateway/mlflow/v1/chat/completions with "
          f'{{"model": "{ENDPOINT_NAME}", ...}}')


if __name__ == "__main__":
    main()
