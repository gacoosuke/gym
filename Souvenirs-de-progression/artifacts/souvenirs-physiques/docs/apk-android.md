# Création de l’APK Android

L’application utilise Capacitor et embarque l’interface web. Les photos et les comptes restent sur Cloudflare : l’APK doit donc être compilé avec l’adresse HTTPS de l’API Pages déployée.

## Préparer Android

Installer Android Studio avec un JDK et le SDK Android. Depuis le dossier `artifacts/souvenirs-physiques`, ajouter la plateforme une seule fois :

```sh
pnpm run android:add
```

Cette commande crée le projet natif `android/`. Il n’est pas nécessaire de la relancer ensuite.

## Construire l’APK de test

Remplacer l’adresse par le domaine Pages réel :

```sh
VITE_API_BASE_URL=https://<nom-du-projet>.pages.dev pnpm run android:apk
```

Le fichier APK de débogage est créé ici :

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Installer ce fichier sur un téléphone de test. À l’ouverture, choisir son profil et saisir son PIN. L’autorisation de caméra est demandée lors de la première prise de photo. La session reste mémorisée sur cet appareil jusqu’à sa fermeture dans les paramètres.

## Publier une version signée

Pour distribuer l’application, ouvrir le projet `android/` dans Android Studio et utiliser **Build > Generate Signed Bundle / APK**. Créer ou sélectionner une clé de signature et conserver le fichier de clé ainsi que ses mots de passe hors du dépôt. Un APK de débogage n’est pas adapté à une distribution publique.

Après un changement de l’interface, relancer `pnpm run android:apk` pour reconstruire les ressources web et synchroniser Capacitor.