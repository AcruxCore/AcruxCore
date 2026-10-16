from langsmith import Client, traceable
from langsmith.wrappers import wrap_openai

langsmith = Client()
client = wrap_openai(OpenAI(api_key=API_KEY, base_url=BASE_URL, max_retries=5, timeout=180))
ROLES = {"SystemMessagePromptTemplate": "system", "HumanMessagePromptTemplate": "user",
         "AIMessagePromptTemplate": "assistant"}


def pull_messages(name: str, tag: str):
    """Read a prompt commit without langchain-core: unpack LangChain's serialized manifest."""
    commit = langsmith.pull_prompt_commit(f"{name}:{tag}")
    messages = [{"role": ROLES[m["id"][-1]], "content": m["kwargs"]["prompt"]["kwargs"]["template"]}
                for m in commit.manifest["kwargs"]["messages"]]
    link = {"lc_hub_repo": name, "lc_hub_commit_hash": commit.commit_hash}  # links the call to the commit
    return messages, {"langsmith_extra": {"metadata": link}}


def make_app(tag: str = "production"):
    def step(name: str, kind: str):
        return traceable(name=name, run_type="tool" if kind == "tool" else "chain")

    return build_app(lambda name: pull_messages(name, tag), client, step)
