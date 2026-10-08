---
"@btravstack/entity": minor
---

`SomeEntity.parseCreate(command)` parses a create command before the generated fields exist, answering the entity's own `InvalidEntity` and exactly what a factory's function accepts. It checks every field schema and each nested entity's own rules; this entity's invariants still wait for the create.
