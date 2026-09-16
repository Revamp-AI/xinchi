"""Extract contact identity fields from a copied macOS .abbu archive (no restore)."""
import json
import pathlib
import shutil
import sqlite3
import sys
import tempfile


def read_archive(path):
    root = pathlib.Path(path).resolve()
    if root.suffix.lower() != '.abbu' or not root.is_dir():
        raise ValueError('Choose a macOS Contacts .abbu archive directory.')
    databases = sorted(root.rglob('AddressBook-v*.abcddb'))
    if not databases or len(databases) > 30:
        raise ValueError('No supported Contacts databases found in the archive.')
    records = []
    with tempfile.TemporaryDirectory(prefix='focus-apple-contacts-') as work:
        for index, database in enumerate(databases):
            if database.is_symlink():
                raise ValueError('Contact databases must be regular archive files.')
            target = pathlib.Path(work) / str(index)
            target.mkdir()
            for suffix in ['', '-wal', '-shm']:
                source = pathlib.Path(str(database) + suffix)
                if source.exists():
                    if source.stat().st_size > 256 * 1024 * 1024 or source.is_symlink():
                        raise ValueError('Contact database is too large or is a link.')
                    shutil.copyfile(source, target / (database.name + suffix))
            con = sqlite3.connect(f'file:{target / database.name}?mode=ro', uri=True)
            con.row_factory = sqlite3.Row
            try:
                tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {'ZABCDRECORD', 'ZABCDCONTACTINDEX'}.issubset(tables):
                    raise ValueError('This Contacts archive schema is not supported.')
                indexes = list(con.execute('SELECT * FROM ZABCDCONTACTINDEX'))
                contact_ids = {r[k] for r in indexes for k in ['ZCONTACT', 'Z22_CONTACT'] if k in r.keys() and r[k]}
                if len(contact_ids) > 10000:
                    raise ValueError('Import at most 10,000 contact cards per source.')
                fields = {}
                for table, column, kind in [('ZABCDEMAILADDRESS', 'ZADDRESS', 'emails'), ('ZABCDPHONENUMBER', 'ZFULLNUMBER', 'phones'), ('ZABCDURLADDRESS', 'ZURL', 'urls'), ('ZABCDSOCIALPROFILE', 'ZURLSTRING', 'urls')]:
                    if table not in tables:
                        continue
                    for field in con.execute(f'SELECT * FROM "{table}"'):
                        owner = next((field[k] for k in ['ZOWNER', 'Z22_OWNER'] if k in field.keys() and field[k]), None)
                        value = field[column]
                        if owner in contact_ids and isinstance(value, str) and value.strip():
                            fields.setdefault(owner, {}).setdefault(kind, []).append(value.strip())
                for row in con.execute('SELECT * FROM ZABCDRECORD'):
                    if row['Z_PK'] not in contact_ids:
                        continue
                    def value(key):
                        return str(row[key] or '').strip() if key in row.keys() else ''
                    uid = value('ZUNIQUEID')
                    if not uid:
                        raise ValueError('A contact is missing its stable archive identifier.')
                    name = ' '.join(filter(None, [value('ZFIRSTNAME'), value('ZMIDDLENAME'), value('ZLASTNAME')])) or value('ZNICKNAME') or value('ZORGANIZATION')
                    records.append({'key': uid, 'name': name, 'company': value('ZORGANIZATION'), 'role': value('ZJOBTITLE'), **fields.get(row['Z_PK'], {})})
            finally:
                con.close()
    return records


if __name__ == '__main__':
    try:
        print(json.dumps(read_archive(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        print('Could not read Contacts archive: ' + str(error), file=sys.stderr)
        sys.exit(1)
