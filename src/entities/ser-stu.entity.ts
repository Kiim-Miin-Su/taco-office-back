/**
 * SER_STU — docs/contracts/db/erd.dbml v4.3 에서 생성했습니다.
 *
 * 표 이름은 명세서 v2 의 전역 배열 이름을 **그대로** 씁니다 (명세서 §82).
 * 이름을 바꾸면 마이그레이션과 명세서 대조가 둘 다 어려워집니다.
 */
import { Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'ser_stu' })
export class SerStu {
  @PrimaryColumn({ type: 'bigint' })
  serId: number;

  @PrimaryColumn({ type: 'bigint' })
  studentId: number;
}
