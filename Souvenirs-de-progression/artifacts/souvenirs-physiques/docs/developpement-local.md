# Développement local

Les commandes se lancent depuis la racine du workspace avec `pnpm --filter @workspace/souvenirs-physiques`.

## Préparer les données locales

1. Copier `artifacts/souvenirs-physiques/.dev.vars.example` vers `.dev.vars` dans le même dossier.
2. Remplacer `SETUP_SECRET` par une chaîne aléatoire d’au moins 32 caractères. Garder ce fichier local : il est ignoré par Git.
3. Appliquer la migration D1 locale :

```sh
pnpm --filter @workspace/souvenirs-physiques run db:local
```

4. Démarrer l’application :

```sh
pnpm --filter @workspace/souvenirs-physiques run dev
```

Le workflow de développement lance Vite et Cloudflare Pages Functions. Le site est disponible dans l’aperçu Replit ; les appels `/api` y sont transmis au Worker local. Wrangler utilise ses stockages locaux pour D1 et R2.

## Initialiser les profils

Dans un second terminal, lancer l’assistant une seule fois :

```sh
pnpm --filter @workspace/souvenirs-physiques run setup:pins
```

Laisser l’adresse proposée pour le Worker local, puis saisir le secret et trois codes différents de 6 à 12 chiffres. La saisie est masquée. Les codes sont salés et hachés avant d’être enregistrés ; ils ne peuvent pas être récupérés depuis la base.

Pour vérifier l’API locale :

```sh
curl http://127.0.0.1:8788/api/healthz
```

## Arrêter ou réinitialiser les données locales

Arrêter le workflow ferme Vite et le Worker. Les données D1/R2 simulées restent locales au workspace. Pour repartir avec un album vierge, supprimer le dossier `.wrangler/state` de l’artefact ; cette suppression efface les photos, profils configurés, sessions, commentaires et réactions locaux. Elle n’affecte pas Cloudflare.