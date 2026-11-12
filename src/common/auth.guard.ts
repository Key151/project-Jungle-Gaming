/**
 * AuthGuard no-op.
 *
 * DECISÃO (documentada em ARCHITECTURE.md): este desafio NÃO exige
 * autenticação implementada — o enunciado aceita a ausência dela, desde que
 * a decisão e o ponto de extensão fiquem explícitos.
 *
 * Ponto de extensão: esta classe é o lugar natural para plugar um IdP
 * externo (Keycloak, Zitadel, Cognito...). O desenho pretendido é:
 *
 *   1. validar o Bearer token contra o JWKS do IdP (issuer/audience);
 *   2. extrair o `providerId` da claim do provedor (ex.: `azp`/`client_id`)
 *      e usá-lo para autorizar a operação;
 *   3. injetar um `ProviderIdentity` no contexto da requisição, que a
 *      camada de aplicação valida contra o `providerId` da mensagem.
 *
 * Os endpoints /health/* ficam FORA do guard (não exigem autenticação),
 * assim como exige o enunciado.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class NoOpAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
