import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class InvoiceLineDto {
  @ApiPropertyOptional({ type: String, nullable: true }) subKey?: string | null;
  @ApiProperty() label!: string;
  @ApiProperty() count!: number;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() amount!: number;
}

export class InvoiceDto {
  @ApiProperty() id!: number;
  @ApiProperty() studentId!: number;
  @ApiProperty() studentName!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) grade?: string | null;
  @ApiProperty() yearMonth!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: Number, nullable: true, description: '금액 — canMoney 가 아니면 null 로 내려간다 (D-R39)' }) amount!: number | null;
  @ApiProperty({ type: Number, nullable: true }) paidAmount!: number | null;
  @ApiProperty({ enum: ['draft', 'sent', 'unpaid', 'partial', 'paid', 'void'] }) state!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) issuedOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) dueOn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paidAt?: string | null;
  @ApiProperty({ description: '예정일이 지났는데 안 들어온 날 수. 0이면 연체 아님' }) overdueDays!: number;
  @ApiProperty({ type: [InvoiceLineDto] }) lines!: InvoiceLineDto[];
}

export class PaymentDto {
  @ApiProperty() id!: number;
  @ApiProperty() paidOn!: string;
  @ApiPropertyOptional({ type: Number, nullable: true }) studentId?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) studentName?: string | null;
  @ApiProperty({ type: Number, nullable: true }) amount!: number | null;
  @ApiPropertyOptional({ type: String, nullable: true }) method?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) invId?: number | null;
}

export class PayoutDto {
  @ApiProperty() id!: number;
  @ApiProperty() staffId!: number;
  @ApiProperty() staffName!: string;
  @ApiProperty() yearMonth!: string;
  @ApiProperty() hours!: string;
  @ApiProperty({ type: Number, nullable: true }) gross!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '리포트 지연 차감 (D-R32)' }) lateRepCut!: number | null;
  @ApiProperty({ type: Number, nullable: true }) incomeTax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) localTax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) net!: number | null;
  @ApiProperty() state!: string;
}

export class MoneySummaryDto {
  @ApiProperty() invoiceCount!: number;
  @ApiProperty({ type: Number, nullable: true }) billed!: number | null;
  @ApiProperty({ type: Number, nullable: true }) collected!: number | null;
  @ApiProperty({ type: Number, nullable: true }) outstanding!: number | null;
  @ApiProperty() overdueCount!: number;
  @ApiProperty({ description: '금액을 볼 수 있는가 (D-R39 · 사람별 예외까지 반영된 canMoney)' }) canSeeAmounts!: boolean;
}

export class AccountingDto {
  @ApiProperty({ type: MoneySummaryDto }) summary!: MoneySummaryDto;
  @ApiProperty({ type: [InvoiceDto] }) invoices!: InvoiceDto[];
  @ApiProperty({ type: [PaymentDto] }) payments!: PaymentDto[];
  @ApiProperty({ type: [PayoutDto] }) payouts!: PayoutDto[];
}
