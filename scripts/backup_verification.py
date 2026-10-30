"""Strict parsing of complete psql JSON documents; no database access."""
import json


def _unique_members(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate verification JSON member')
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError('Non-finite verification JSON')


def parse_backup_output(text):
    """Decode two complete JSON values, including embedded formatting newlines.

    psql emits counts followed by a json_agg history array. Newlines inside the
    array are JSON whitespace, not record boundaries. Reject trailing output,
    missing documents, unexpected shapes and incomplete history rows.
    """
    decoder = json.JSONDecoder(object_pairs_hook=_unique_members,
                               parse_constant=_invalid_constant)
    documents = []
    offset = 0
    while offset < len(text):
        while offset < len(text) and text[offset].isspace():
            offset += 1
        if offset == len(text):
            break
        if len(documents) == 2:
            raise ValueError('Unexpected trailing verification output')
        value, end = decoder.raw_decode(text, offset)
        documents.append(value)
        if end < len(text) and not text[end].isspace():
            raise ValueError('Verification documents require whitespace separator')
        offset = end
    if len(documents) != 2:
        raise ValueError('Expected counts and migration history')
    counts, history = documents
    if not isinstance(counts, dict) or not counts or any(
            not isinstance(k, str) or type(v) is not int or v < 0
            for k, v in counts.items()):
        raise ValueError('Invalid restored counts')
    if not isinstance(history, list) or not history:
        raise ValueError('Invalid migration history')
    for row in history:
        if not isinstance(row, dict) or set(row) != {
                'migration_name', 'checksum', 'completed', 'rolled_back'}:
            raise ValueError('Invalid migration record')
        if not isinstance(row['migration_name'], str) or not isinstance(row['checksum'], str):
            raise ValueError('Invalid migration identity')
        if type(row['completed']) is not bool or type(row['rolled_back']) is not bool:
            raise ValueError('Invalid migration completion state')
    return counts, history
