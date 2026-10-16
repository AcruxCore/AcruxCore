"""Push the four prompts to the LangSmith prompt hub.

LangSmith's push_prompt needs a LangChain prompt object, so this one setup script needs
langchain-core. The app itself (langsmith_leg.py) does not.

    pip install langsmith langchain-core python-dotenv
    python langsmith_push_prompts.py --version 1 --tag production
"""

import argparse

from langchain_core.prompts import ChatPromptTemplate
from langsmith import Client

from common import PROMPT_NAMES, load_prompt_file

ROLE = {"system": "system", "user": "human", "assistant": "ai"}


def push(version: int, tag: str | None, names: list[str] = PROMPT_NAMES):
    client = Client()
    for name in names:
        messages = [(ROLE[m["role"]], m["content"]) for m in load_prompt_file(name, version)]
        # Our files use {{variable}}, which is mustache syntax; the default f-string format uses {variable}.
        template = ChatPromptTemplate.from_messages(messages, template_format="mustache")
        url = client.push_prompt(name, object=template, commit_tags=[tag] if tag else None,
                                 commit_description=f"v{version} from prompts/{name}.v{version}.json")
        print(name, "->", url)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", type=int, default=1)
    parser.add_argument("--tag")
    parser.add_argument("--names", help="comma-separated prompt names (default: all four)")
    args = parser.parse_args()
    push(args.version, args.tag, args.names.split(",") if args.names else PROMPT_NAMES)
