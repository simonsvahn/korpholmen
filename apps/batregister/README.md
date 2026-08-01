# Båtregister

Redigerbar lokal-först-master för KBK:s båtar och båtbilder. Appskalet är
datafritt på GitHub Pages. Privat båtdata ligger lokalt i IndexedDB och synkas
som oföränderliga operationsbatcher till `/batregister/ops` i samma Dropbox
App Folder som Matrikeln. Bilder ligger separat i `/batregister/bilder`.

Den låsta startkopian byggs av arbetskopiorna i `privat/kallkopior/`:

```sh
npm run build:migration
npm test
npm run build:publish
```

På localhost kan startkopian aktiveras och därefter laddas upp till Dropbox.
Endast entydiga personnamn och klubbnamn länkas automatiskt till Matrikelns
stabila person-ID. Oklara fall granskas i det separata Excelarket.
