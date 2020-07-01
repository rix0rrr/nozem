
GOAL: recompile as little as possible

A number of design decisions fall out of that. Most importantly: in calculating
whether a node in the tree needs to be rebuilt, use the hashes of the things
that actually impact the result of the build.

SourceHash and OutHash
----------------------

For example, in the package graph:

```
┌────────┐            ┌────────┐
│        │            │        │
│   P1   │───────────▶│   P2   │
│        │            │        │
└────────┘            └────────┘
```

The SOURCES of P1 may have changed, but that doesn't mean its build OUTPUT will
change. Therefore, we can't use the sources of P1 and P2 to calculate the cache
key of P2. We have to use the OUTPUT of P1 and the SOURCES of P2 to calculate
the key.

> Something that falls out of that is when the build starts, we only have the
> SOURCES of P1 and P2, and we don't yet know the OUTPUT of P1. We have to
> perform the build (or use its sourcehash to look up the build output in a
> cache), before we can calculate the sourcehash of P2. We therefore have to
> run through the build graph in order, we can't just wholesale download
> everything from cache when we start.

Split into fine-grained artifact sets
-------------------------------------

We produce fine-grained output so that we can declare very fine dependencies.

For example:

- If TS source changes, we only have to RECOMPILE downstream dependencies if
  the change affected the API. If the change did not affect the downstream API,
  we don't have to recompile the downstream package; instead, it suffices to
  simply rerun the downstream tests.

- Some operations like code generation and linting want to have their output
  copied back to the source tree, so that IDEs can take advantage of the
  outputs (without additional IDE configs).
  tree

So, the build graph from the package graph `P1 -> P2` looks like this (where
the artifact labels mimic file names that would be found inside the artifact
file sets).

```
            .───────────.        copy back                 .───────────.         copy back
           (    p1.ts    )       to source                (    p2.ts    )        to source
            `───────────'          tree                    `───────────'           tree
                  │                  ▲                           │                   ▲
                  ▼                  │                           ▼                   │
            ┌───────────┐            │                     ┌───────────┐             │
            │           │            │                     │           │             │
            │  P1:gen   │            │                     │  P2:gen   │             │
            │           │            │                     │           │             │
            └───────────┘            │                     └───────────┘             │
                  │                  │                           │                   │
                  ▼                  │                           ▼                   │
            .───────────.            │                     .───────────.             │
           (  p1.gen.ts  )───────────┘                    (  p2.gen.ts  )────────────┘
            `───────────'                                  `───────────'
                  │                                              │
                  │                                              │
                  ▼                                              ▼
            ┌───────────┐                                  ┌───────────┐
            │           │                                  │           │
            │ P1:build  │                  ┌──────────────▶│ P2:build  │
            │           │                  │               │           │
            └───────────┘                  │               └───────────┘
                  │                        │                     │
        ┌─────────┴───────────┐            │            ┌────────┴────────┐
        ▼                     ▼            │            ▼                 ▼
  .───────────.         .───────────.      │      .───────────.     .───────────.
 (    p1.js    )       (   p1.d.ts   )─────┘     (    p2.js    )   (   p2.d.ts   )
  `───────────'         `───────────'             `───────────'     `───────────'
        │                                               │
        ├──────────────────────────────────┐            └─────────┐
        ▼                                  │                      ▼
  ┌───────────┐                            │                ┌───────────┐
  │           │                            │                │           │
  │  P1:test  │                            └───────────────▶│  P2:test  │
  │           │                                             │           │
  └───────────┘                                             └───────────┘
        │                                                         │
        │                                                         │
        ▼                                                         ▼
 .─────────────.                                           .─────────────.
(  p1.test.xml  )                                         (  p2.test.xml  )
 `─────────────'                                           `─────────────'
 ```

 We are not going to represent the entire graph in memory because it's not
 actually 100% arbitrary:

* Every artifact only ever has one producer.

We therefore abstract over the more complex graph
