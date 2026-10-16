from langfuse import Evaluation, get_client, observe
from langfuse.openai import OpenAI  # drop-in OpenAI client that traces every call

langfuse = get_client()
client = OpenAI(api_key=API_KEY, base_url=BASE_URL, max_retries=5, timeout=180)


def make_app(label: str = "production"):
    def get_prompt(name: str):
        prompt = langfuse.get_prompt(name, label=label, type="chat")
        return prompt.prompt, {"langfuse_prompt": prompt}  # links the call to the version

    def step(name: str, kind: str):
        return observe(name=name, as_type="tool" if kind == "tool" else "span")

    return build_app(get_prompt, client, step)
