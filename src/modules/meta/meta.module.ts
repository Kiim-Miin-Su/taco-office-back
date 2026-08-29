import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Kind, Room, Staff, Stu, Sub, Zacc } from '../../entities';
import { MetaController } from './meta.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Kind, Sub, Room, Zacc, Staff, Stu])],
  controllers: [MetaController],
})
export class MetaModule {}
