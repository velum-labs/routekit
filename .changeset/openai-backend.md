---
"@velum-labs/routekit-gateway": patch
---

Move the OpenAI HTTP client out of the backend port module so every provider transport lives in its own file and port changes cannot drag Chat Completions / Responses egress with them.
