import type { Logger } from '@edu/observability';

/**
 * Outbound transactional email.
 *
 * NO DELIVERY IS IMPLEMENTED. This is the seam, not the feature: email
 * verification and password reset both need to hand a single-use token to a
 * human, and that hand-off has to exist somewhere in the design even before a
 * provider is chosen.
 *
 * Defining the port now buys two things. The token never has to be returned in
 * an HTTP response — which would be a straightforward account-takeover
 * vulnerability, since anyone who can trigger a reset could then read the token.
 * And tests can capture what would have been sent without a mail server.
 *
 * `LoggingMailDelivery` is the default. It records that a message WOULD have
 * been sent and deliberately does not log the token: an operator reading logs
 * must not be able to take over an account with what they find there.
 */
export interface MailDelivery {
  sendEmailVerification(to: string, token: string): Promise<void>;
  sendPasswordReset(to: string, token: string): Promise<void>;
}

export function createLoggingMailDelivery(logger: Logger): MailDelivery {
  const note = (kind: string): void => {
    logger.warn('email delivery is not implemented; message dropped', {
      kind,
      // Neither the recipient address nor the token is logged. The address is
      // personal data and the token is a credential.
      remediation: 'configure a mail provider before enabling verification enforcement',
    });
  };

  return {
    async sendEmailVerification() {
      note('email_verification');
    },
    async sendPasswordReset() {
      note('password_reset');
    },
  };
}
