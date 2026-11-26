# Implementation and evidence notice

The application is independently implemented for interoperability with the
UV-K10 Pro / K8 profile. The channel codec and parts of the protocol model are
ports of MIT-licensed work in `guanzi008/uv-k10pro-firmware`.

Vendor firmware, update containers, APKs, Windows executables/DLLs, complete
vendor schemas, original channel databases, full language resources and raw
disassembly are not distributed here. Tests contain synthetic data, small
interoperability fixtures, and independently produced observations. Optional
reference replay scripts require the user to obtain matching inputs separately.

The GB2312 table contains standardized character mappings generated from a
standard codec. Browser APIs and WebCrypto are provided by the host browser.
JSDOM and its dependencies are development-only packages with their own licenses;
they are not included in `dist/`.

Product and chip names identify compatibility targets and evidence sources.
They do not imply manufacturer endorsement. No claim of complete clean-room
separation from the studied executable behavior is made.
