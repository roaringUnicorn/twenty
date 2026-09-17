import { QueryRunner } from 'typeorm';

import { RegisteredInstanceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-instance-command.decorator';
import { FastInstanceCommand } from 'src/engine/core-modules/upgrade/interfaces/fast-instance-command.interface';

// Creates the core."suiteUserIdentity" table backing SuiteUserIdentityEntity,
// which links an OVH Suite (Clavis) subject to a Twenty user. Kept idempotent
// because this command travels as a patch on top of upstream: a deployment can
// meet it again after an upstream bump moves it to another version directory.
@RegisteredInstanceCommand('2.42.0', 1789739176254)
export class CreateSuiteUserIdentityCoreTableFastInstanceCommand
  implements FastInstanceCommand
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS "core"."suiteUserIdentity" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "issuer" character varying NOT NULL, "subject" character varying NOT NULL, "userId" uuid NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UNIQ_SUITE_USER_IDENTITY_ISSUER_SUBJECT" UNIQUE ("issuer", "subject"), CONSTRAINT "PK_7042b394c4a432657aadafc4a17" PRIMARY KEY ("id"), CONSTRAINT "FK_SUITE_USER_IDENTITY_USER_ID" FOREIGN KEY ("userId") REFERENCES "core"."user"("id") ON DELETE CASCADE ON UPDATE NO ACTION)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_SUITE_USER_IDENTITY_USER_ID" ON "core"."suiteUserIdentity" ("userId")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX IF EXISTS "core"."IDX_SUITE_USER_IDENTITY_USER_ID"',
    );
    await queryRunner.query(
      'DROP TABLE IF EXISTS "core"."suiteUserIdentity"',
    );
  }
}
