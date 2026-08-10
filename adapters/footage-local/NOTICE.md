# CUT local footage backend notices

The CUT local footage adapter (`local-clip-sidecar.mjs`) is part of CUT and is distributed under CUT's MIT License.

The optional `cut footage setup --backend local` command installs third-party software and model files into the user's CUT footage home. Those files are not dependencies of the main CUT package and are not bundled in the CUT package tarball.

- `@huggingface/transformers` 4.2.0 is distributed under the Apache License 2.0. Its installed package retains its license and notices.
- `Xenova/clip-vit-base-patch32` revision `d15189d7028b43f1d3e65039190477f6af591c2a` is a Transformers.js conversion of OpenAI CLIP ViT-B/32.
- OpenAI CLIP is distributed under the MIT License.

The installed dependency tree contains additional third-party packages. Their license files and notices remain in the immutable local backend installation. This notice is informational and does not replace those license terms.
