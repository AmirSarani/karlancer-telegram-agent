# Legacy (not loaded in production)

`playwright-karlancer.STUB.js` is retained only as historical reference from the MVP.
It must **never** be imported by `src/index.js`, MCP, or worker.
CI runs `npm run guard:playwright` to enforce this.
