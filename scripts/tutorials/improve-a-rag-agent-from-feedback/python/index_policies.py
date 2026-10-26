"""Store Brewline's policies in Milvus, one vector per paragraph.

Indexing is a separate job from the agent: a real shop runs it when a policy
changes, and the agent only searches. Run it once before agent.py. A second run
rebuilds the collection only when the paragraphs changed.

Setup:
    pip install "pymilvus[model]"
    export MILVUS_URI=http://localhost:19530      # a Milvus server, or a Milvus Lite file

Run:
    python index_policies.py
"""

from agent import COLLECTION, DATA, EMBED, MILVUS


def paragraphs():
    """One chunk per paragraph of ../data/policies/*.md. Headings carry no policy."""
    for path in sorted((DATA / "policies").glob("*.md")):
        for para in path.read_text().split("\n\n"):
            para = para.strip()
            if para and not para.startswith("#"):
                yield {"source": path.stem, "text": para}


def stored_rows() -> int:
    if not MILVUS.has_collection(COLLECTION):
        return 0
    return MILVUS.query(COLLECTION, filter="id >= 0", output_fields=["count(*)"])[0]["count(*)"]


def main() -> None:
    chunks = list(paragraphs())
    if stored_rows() == len(chunks):
        print(f"= {COLLECTION} already holds all {len(chunks)} paragraphs")
        return
    if MILVUS.has_collection(COLLECTION):
        MILVUS.drop_collection(COLLECTION)  # out of date: rebuild it from the files
    MILVUS.create_collection(COLLECTION, dimension=EMBED.dim)
    vectors = EMBED.encode_documents([c["text"] for c in chunks])
    MILVUS.insert(COLLECTION, [{"id": i, "vector": v, **c} for i, (c, v) in enumerate(zip(chunks, vectors))])
    print(f"+ indexed {len(chunks)} paragraphs into {COLLECTION}")


if __name__ == "__main__":
    main()
