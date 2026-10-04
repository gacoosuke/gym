# Déploiement sur Cloudflare

Le site et les Pages Functions sont déployés ensemble. D1 contient les comptes et métadonnées ; les fichiers sont conservés dans un bucket R2 privé et ne sont lus qu’avec une session valide.

## Créer les ressources Cloudflare

Depuis le dossier `artifacts/souvenirs-physiques` :

```sh
pnpm exec wrangler d1 create souvenirs-physiques
pnpm exec wrangler r2 bucket create souvenirs-physiques
pnpm exec wrangler pages project create souvenirs-physiques --production-branch main
```

Copier l’ID D1 retourné par la première commande dans `wrangler.toml`, à la place de l’ID d’exemple. Les noms de la base, du bucket et du projet doivent correspondre à la configuration. Si le nom du bucket est déjà pris globalement, choisir un autre nom et le reporter dans le fichier.

## Définir le secret, migrer puis publier

La configuration initiale des codes PIN est protégée par un secret distinct. Ne pas le mettre dans le code ou dans Git.

```sh
pnpm exec wrangler pages secret put SETUP_SECRET --project-name souvenirs-physiques
pnpm run db:remote
pnpm run deploy:cloudflare
```

La valeur de `SETUP_SECRET` doit être aléatoire et contenir au moins 32 caractères. Le nom de projet `souvenirs-physiques` est également utilisé par `wrangler.toml`.

## Créer les trois codes PIN

Après le premier déploiement, lancer depuis le dossier de l’artefact :

```sh
pnpm run setup:pins
```

Saisir l’URL HTTPS `https://<nom-du-projet>.pages.dev`, le même secret que celui enregistré côté Cloudflare, puis trois PIN différents de 6 à 12 chiffres. Cette route est verrouillée définitivement dès que les trois PIN sont initialisés. Pour une correction ultérieure, chaque membre peut fermer sa session dans les paramètres ; la réinitialisation des PIN nécessite une intervention maîtrisée sur la base.

## Mises à jour

Après une modification de schéma, exécuter `pnpm run db:remote` avant de redéployer. Pour publier une nouvelle version de l’application et des fonctions :

```sh
pnpm run deploy:cloudflare
```

Ne pas rendre le bucket R2 public : les photos passent par la route authentifiée `/api/media/:id/content`. L’export JSON contient les métadonnées, pas les fichiers image.