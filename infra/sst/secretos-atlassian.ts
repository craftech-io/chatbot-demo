// Credenciales de Atlassian, compartidas por el adaptador de JSM (./tools.ts) y
// el ingestor de Confluence (./ingesta.ts): es la misma service account y el
// mismo tenant, cambian los scopes.
//
// OAuth 2.0 client_credentials, no API token: los API tokens de Atlassian vencen
// cada año. Se crean en Atlassian Administration → Directory → Service accounts.
// Scopes: write:servicedesk-request (JSM), read:space:confluence y
// read:page:confluence (ingestor).
//
// Default "" en todos: el stack despliega sin Atlassian configurado y cada
// capacidad avisa que no tiene destino en vez de cortar el deploy.
export const atlassianClientId = new sst.Secret("AtlassianClientId", "");
export const atlassianClientSecret = new sst.Secret("AtlassianClientSecret", "");
// Sale una vez de https://<sitio>.atlassian.net/_edge/tenant_info
export const atlassianCloudId = new sst.Secret("AtlassianCloudId", "");

