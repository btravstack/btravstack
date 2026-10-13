---
"@btravstack/orpc-server": patch
---

Honor custom HTTP error statuses declared in each procedure's contract error entries on OpenAPI routes and in generated documents. Statuses stay local to the procedure, preserving standard validation and access errors, defect masking, and observation.
