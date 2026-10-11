# License and dependency notices

This repository is distributed under the [MIT License](LICENSE).
The source-code publication is authorized by the repository owner.
The package keeps `private: true` because npm publication is not part of this
source release.

The reviewed distribution is the 21-file allowlist in
`scripts/verify-release.mjs`, including the license and manifest. Changes to that
boundary require a new review of the added material.

There are no third-party package dependencies, bundled fonts, character artwork,
models, audio or video. The demo and test fixtures use generic synthetic text.
The browser bundle is generated from the included source modules. No separate
third-party copyright or license notices were identified in these reviewed files.

Node.js, npm and the browser are execution tools. Their binaries are not included
in the distribution. Applications integrating this module must independently
review the rights to their own caption text, assets and dependencies.
