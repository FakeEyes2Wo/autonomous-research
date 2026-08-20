import asyncio, json
from mcp.client.streamable_http import streamablehttp_client
from mcp import ClientSession

async def main():
    async with streamablehttp_client("https://mcp.draw.io/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            for t in tools.tools:
                if t.name == "create_diagram":
                    print(json.dumps(t.inputSchema, ensure_ascii=False, indent=2))
                    print("DESC:", t.description)

asyncio.run(main())
