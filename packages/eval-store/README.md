# @velum-labs/routekit-eval-store

Effect-native immutable raw evaluation runs and separately published snapshots.
Raw runs are write-once; the online request path never reads this store.

The `./platform` entry point adds content-addressed local/Vercel Blob storage
and a resumable local experiment ledger. The Vercel app supplies the production
Neon ledger against the same interface.
