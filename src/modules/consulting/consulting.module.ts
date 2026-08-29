import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Lead } from '../../entities';
import { ConsultingController } from './consulting.controller';
import { ConsultingService } from './consulting.service';

@Module({
  imports: [TypeOrmModule.forFeature([Lead])],
  controllers: [ConsultingController],
  providers: [ConsultingService],
})
export class ConsultingModule {}
