# [1.1.0](https://github.com/neffbirkley/chatter-mcp/compare/v1.0.0...v1.1.0) (2026-06-03)

### Bug Fixes

- make concurrent cold-start of the database robust ([7746ee3](https://github.com/neffbirkley/chatter-mcp/commit/7746ee3479df57251eee5f89cc6930995726a0f4))

### Features

- clearer tool descriptions and server instructions ([71b76c0](https://github.com/neffbirkley/chatter-mcp/commit/71b76c033e5f43dc9dab2e78368345bc32ad2ef0))

# 1.0.0 (2026-06-03)

### Bug Fixes

- harden cleanup and CI supply chain (P3) ([e5f72d4](https://github.com/neffbirkley/chatter-mcp/commit/e5f72d4478a6d5a78952ac563612407e57774038))
- serialize recv across processes and close DB on shutdown ([054264b](https://github.com/neffbirkley/chatter-mcp/commit/054264b326abba23a30fbaab154e78e21cd7417f))

### Features

- add peek, recv backpressure, and join-from-now ([ace188b](https://github.com/neffbirkley/chatter-mcp/commit/ace188b74a253012f08dfa8f513670a4412ed957))
- initial agent-mailbox MCP server ([6233b59](https://github.com/neffbirkley/chatter-mcp/commit/6233b5933512811eb8f73ada4a122533a6c9c261))
- name leases, identity guidance, and richer discovery ([9f549f6](https://github.com/neffbirkley/chatter-mcp/commit/9f549f672f6a9a933e691a2b4d426d7404e0645c))
- structured tool output, robust errors, richer payloads ([da1156b](https://github.com/neffbirkley/chatter-mcp/commit/da1156be608a65b1ee6d9091267aebb4397b2bb5))

### BREAKING CHANGES

- send and recv now require a `token` from open.
