# CUT local YAMNet adapter notices

The adapter source in this directory is part of CUT and is licensed under the
repository's MIT license.

`yamnet_label_list.txt` contains the ordered 521 AudioSet ontology display
labels used by YAMNet. AudioSet ontology data is provided by Google under the
[Creative Commons Attribution 4.0 International license](https://creativecommons.org/licenses/by/4.0/).
CUT preserves the exact ordered label bytes so analysis cannot silently map a
model score to a different class.

YAMNet model bytes, Python, NumPy, and LiteRT are not bundled. Users install and
authorize those bytes separately; CUT records their exact identities and the
caller's license/provenance declarations without providing legal clearance.
