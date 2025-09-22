
# MrLarbin → DLive Chat (Render Ready)

Petit service Node/Express qui effectue l'OAuth2 DLive, obtient un access token avec `chat:write`, puis envoie un message dans le chat d'un streamer (ex: `skrymi`) via l'API GraphQL de DLive.

## Déploiement sur Render

1. **Créer un repo Git** avec ces fichiers. (Tu peux importer directement ce zip sur GitHub.)
2. Aller sur **render.com** → *New +* → **Web Service** → connecter le repo.
3. Render détecte `render.yaml` et propose le service.
4. Dans l'onglet **Environment**, ajouter les variables **réelles** :
   - `DLIVE_CLIENT_ID` = *ton App ID*
   - `DLIVE_CLIENT_SECRET` = *ton App Secret*
   - (Les autres valeurs par défaut sont déjà posées, modifiables au besoin)
5. Déployer.

> **Redirect URI** côté DLive (dans la fiche app) : `https://mrlarbin-dlive.onrender.com/oauth/callback`

## Utilisation

- Healthcheck : `GET /` → "OK - MrLarbin up"
- Lancer l'auth : `GET /auth/start`
- Envoi ad hoc (message + cible) : `GET /send?msg=Hello%20Skrymi&to=skrymi`

## Remarques techniques

- Endpoints OAuth2 DLive :
  - Authorize: `https://dlive.tv/o/authorize`
  - Token: `https://dlive.tv/o/token`
- Scopes : `chat:write` (+ éventuellement `identity`).
- Durées (doc DLive) : access token 30j, refresh token 1 an.
- Endpoint GraphQL : `https://graphigo.prd.dlive.tv/`

### Mutation

Le nom de mutation pour envoyer un message peut varier selon le schéma exposé par DLive.
Le code utilise `sendChatMessage(streamer: String!, message: String!)`. Si l'appel renvoie une erreur
de champ inconnu, ouvre la page du schéma des mutations (docs DLive) et adapte le nom/les paramètres.

## Sécurité

- **Ne commit jamais** de secret. Utilise les Variables d'environnement Render.
- Si tu as besoin d'envoyer régulièrement, implémente la **persistance & refresh** du token.
