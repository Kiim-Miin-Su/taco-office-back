import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lead } from '../../entities';
import { ExecController } from './exec.controller';
import { ExecService } from './exec.service';

@Module({
  imports: [TypeOrmModule.forFeature([Lead])],
  controllers: [ExecController],
  providers: [ExecService],
})
export class ExecModule {}
