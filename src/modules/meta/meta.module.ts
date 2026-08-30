import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Kind, Room, Staff, Stu, Sub, Zacc } from '../../entities';
import { MetaController } from './meta.controller';
import { MetaService } from './meta.service';

@Module({
  imports: [TypeOrmModule.forFeature([Kind, Sub, Room, Zacc, Staff, Stu])],
  controllers: [MetaController],
  providers: [MetaService],
})
export class MetaModule {}
