# nozem

A very particular build tool for a very specific situation.

If you don't know whether you need this, you don't.

## Usage

Usage:

```
$ yarn install --frozen-lockfile
$ npx nozem from-lerna
$ npx nozem build
```

To use S3 caching, put the following file in a directory above your repository:

```
nozem-cache.json

{
    "cacheBucket": {
        "bucketName": "...",
        "region": "...",
        "profileName": "..."
    }
}
```

Get me to make you a user to a shared cache.


## Troubleshooting

# Docker fails with: unable to create context store: $HOME is not defined

Docker > Preferences > Command Line > Uncheck **Enable Cloud Experience**.
