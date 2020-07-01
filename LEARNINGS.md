Learnings
============

- pkglint requires ../../../package.json outside its own root. Big no-no, but there we go.

Running pkglint during build leads to these kinds of wonderful errors:

- [naming/package-matches-directory] name should be "src", is "cdk-build-tools" (fixable)
- [package-info/repository] repository.directory should be ".nazel-build/build/repo-cdk-build-tools/src", is "tools/cdk-build-tools" (fixable)

CopyBack breaks for source directories that have `node_modules` installed into them directly;
a proper copy-back should clean all artifacts before copying (otherwise branch switching
will suck), but that will break those modules.

All in all, we're better off just dumping pkglint.

Also the eslint config uses references outside the package directories:

    Error: Cannot find module '../../../tools/cdk-build-tools/config/eslintrc'

eslint references are fixable by turning them into symbolic imports into dependency packages.

TSConfig project references also point OUTSIDE the root.  Removing "references"
leads to `.ts` files being recompiled with different settings, leading to errors like:

    ../../../cache/b7eda1258d4fad16fa463f3255d9ac48025376d2/src/lib/private/runtime-info.ts(68,8): error TS2532: Object is possibly 'undefined'.

Need the concept of a sourceHash and an outHash, to short-circuit
the cases where a package's sources did change, but in a way that
has no bearing on the outputs (and so hence, we can short-circuit
dependency changes).

pkglint and eslint both require outside their own repo.


- Need concept of a "source" command (which can be pre-build generate.sh scripts etc)
  Right now hacked with `$NZL_PACKAGE_SOURCE` var but that sucks and
  should go away. Code generators and linters should use this.


> IDEA! Because we *know* we're doing TS, we can decide not to recompile downstream if we can see that only
> *implementation* (.js) changed, not API (.d.ts). This allows skipping of compilation step, NOT skipping of tests!
> This is the same kind of optimization `tsc -b` does.

Need to support repo-in-repo, for embedded Lambdas.

Need to support reflection, so that we can express things like `depends on $all_packages[contains(l1)]` or
something.


Codegen must be done in the source tree (or at least *sent back* to the source tree), s.t.
the IDE can read it.


There could be a different in build dependencies and runtime dependencies
for packages that supply tools. For example: cfn2ts depends on cfnspec. It
only needs to depend on the API to compile it, but it depends on the impl
to RUN it.

