"""Create a project on a running local Pawabase stack for the SDK's live tests.

    PYTHONPATH=<repo> python live-provision.py <state dir>

Writes <state dir>/config.json with the gateway URL and the project's keys.
Needs the stack to be up (see scripts/dev.sh), with PAWABASE_CODE_PATH pointing at
examples/code so the `demo` project has its `hello` function.
"""

from __future__ import annotations

import asyncio
import json
import sys

from pawabase_core.clients import ServiceClient

GATEWAY = "http://127.0.0.1:18080"
API = "http://127.0.0.1:8001"
SECRET = "dev-internal-secret-change-me-please"


async def main(state: str) -> None:
    api = ServiceClient(API, secret=SECRET, issuer="studio", audience="api")
    ref, env = "demo", "development"
    created = await api.post(
        "/platform/v1/projects",
        json={"ref": ref, "name": "SDK demo", "environments": [env]},
    )
    keys = created["keys"][env]
    base = f"/platform/v1/projects/{ref}/envs/{env}"

    await api.patch(
        base,
        json={
            "settings": {
                "public_docs": True,
                "realtime": {
                    "channels": [
                        {"pattern": "chat:*", "subscribe": "public", "publish": "public", "presence": True, "history": 50},
                        {"pattern": "user:{{ auth.user_id }}", "subscribe": "authenticated", "publish": "authenticated", "presence": False},
                        {"pattern": "locked:*", "subscribe": "deny", "publish": "deny", "presence": False},
                    ],
                    "allow_client_publish": True,
                },
            },
        },
    )

    for resource in (
        {
            "name": "authors",
            "fields": [{"name": "name", "type": "string", "required": True}],
            "operations": {op: {"enabled": True, "policy": "public"} for op in ("list", "get", "create", "update", "delete")},
        },
        {
            "name": "posts",
            "fields": [
                {"name": "title", "type": "string", "required": True},
                {"name": "status", "type": "string", "default": "draft"},
                {"name": "views", "type": "integer", "default": 0},
                {"name": "featured", "type": "boolean", "default": False},
                {"name": "org_id", "type": "string"},
                {"name": "author_id", "type": "integer"},
                {"name": "meta", "type": "json"},
            ],
            "relations": [{"name": "author", "type": "belongs_to", "resource": "authors", "field": "author_id"}],
            "operations": {
                "list": {"enabled": True, "policy": "public"},
                "get": {"enabled": True, "policy": "public"},
                "create": {"enabled": True, "policy": "public"},
                "update": {"enabled": True, "policy": "public"},
                "delete": {"enabled": True, "policy": "public"},
            },
        },
        {
            "name": "tasks",
            "fields": [{"name": "title", "type": "string", "required": True}],
            "owner_field": "owner_id",
            "operations": {op: {"enabled": True, "policy": "owner:owner_id"} for op in ("list", "get", "update", "delete")}
            | {"create": {"enabled": True, "policy": "authenticated"}},
        },
    ):
        await api.post(f"{base}/resources", json=resource)
        await api.post(f"{base}/resources/{resource['name']}/migrate")

    await api.post(f"{base}/buckets", json={"name": "pub", "public": True, "write_policy": "authenticated", "signed_uploads": True})
    await api.post(f"{base}/buckets", json={"name": "private", "write_policy": "authenticated", "read_policy": "authenticated", "signed_uploads": True, "max_bytes": 1000})

    await api.post(
        f"{base}/flows",
        json={
            "name": "whoami",
            "definition": {
                "nodes": [
                    {"id": "t", "data": {"block": "trigger.http", "config": {"policy": "public"}}},
                    {
                        "id": "r",
                        "data": {
                            "block": "response.return",
                            "config": {"status": 200, "body": {"auth": "{{ auth }}", "input": "{{ input.body }}"}},
                        },
                    },
                ],
                "edges": [{"id": "e1", "source": "t", "target": "r"}],
            },
        },
    )

    with open(f"{state}/config.json", "w") as handle:
        json.dump(
            {"url": GATEWAY, "project": ref, "environment": env, "publishable": keys["publishable"], "secret": keys["secret"]},
            handle,
            indent=2,
        )
    await api.close()
    print("provisioned", ref, env)


asyncio.run(main(sys.argv[1]))
