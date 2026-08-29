import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Inv } from '../../entities';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';

@Module({
  imports: [TypeOrmModule.forFeature([Inv])],
  controllers: [AccountingController],
  providers: [AccountingService],
})
export class AccountingModule {}
