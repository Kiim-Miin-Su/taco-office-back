/**
 * VERS — docs/contracts/db/erd.dbml v4.5 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: 'vers' })
export class Vers {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: number;

  @Column({ type: 'bigint' })
  libId: number;

  @Column({ type: 'varchar', length: 20 })
  edition: string;

  @Column({ type: 'text', nullable: true })
  fileUrl: string | null;

  @Column({ type: 'date', nullable: true })
  fromDate: string | null;
}
