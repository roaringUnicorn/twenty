import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  type Relation,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

import { UserEntity } from 'src/engine/core-modules/user/user.entity';

@Entity({ name: 'suiteUserIdentity', schema: 'core' })
@Unique('UNIQ_SUITE_USER_IDENTITY_ISSUER_SUBJECT', ['issuer', 'subject'])
@Index('IDX_SUITE_USER_IDENTITY_USER_ID', ['userId'])
export class SuiteUserIdentityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Pinned issuer of the asserting suite, so two suites can never collide on a
  // subject that is only unique within one of them.
  @Column()
  issuer: string;

  // The suite's immutable user id (Clavis JWT `sub`). The link is kept here
  // rather than on the email so a suite-side email change does not orphan the
  // Twenty user.
  @Column()
  subject: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_SUITE_USER_IDENTITY_USER_ID',
  })
  user: Relation<UserEntity>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
